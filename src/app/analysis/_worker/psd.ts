import {
	Observable,
	switchMap,
	switchScan,
	scan,
	throttle,
	Subject,
	map,
	from,
	concatMap,
	distinctUntilChanged,
	filter,
	mergeMap,
	of,
	shareReplay,
	EMPTY,
	merge,
	asyncScheduler,
	scheduled,
	firstValueFrom,
	tap,
	mergeAll,
} from 'rxjs';
import { AccelSampleMs } from '@/app/analysis/_worker/processing';
import { TypedArrayPSD, WelchError, powerSpectralDensity, sumPSDs } from '@/app/analysis/periodogram';
import {
	Rank,
	Tensor2D,
	backend,
	disposeVariables,
	getBackend,
	ready,
	reshape,
	setBackend,
	split,
	tensor2d,
	tidy,
	env,
} from '@tensorflow/tfjs-core';
import BigNumber from 'bignumber.js';
import { DoWork, runWorker } from 'observable-webworker';
import { bufferFifo } from '@/app/analysis/_worker/stream-utils';
import { getLogger } from '@/app/_helpers/logger';
import type { WebGPUBackend } from '@tensorflow/tfjs-backend-webgpu';
import type { MathBackendWebGL } from '@tensorflow/tfjs-backend-webgl';

export type PSDResult = {
	x: TypedArrayPSD;
	y: TypedArrayPSD;
	z: TypedArrayPSD;
	total: TypedArrayPSD;
	// source?: Float64Array[];
};

export function isWebGPUSupported(): boolean {
	return !!(typeof globalThis !== 'undefined' && globalThis.navigator && globalThis.navigator.gpu);
}
let loaded = false;
export async function loadTFJS() {
	if (loaded) {
		return true;
	}
	if (!isWebGPUSupported()) {
		getLogger().info('WebGPU not available, falling back to WebGL');
		await import('@tensorflow/tfjs-backend-webgl');
		await setBackend('webgl');
		getLogger().info('WebGL backend loaded');
	} else {
		try {
			getLogger().info('Loading webgpu backend');
			const tf = await import('@tensorflow/tfjs-backend-webgpu');
			await setBackend('webgpu');
			env().set('WEBGPU_CPU_FORWARD', false);
			getLogger().info('WebGPU backend loaded');
		} catch (e) {
			getLogger().error(e, 'Failed to load webgpu backend, falling back to webgl');
			await import('@tensorflow/tfjs-backend-webgl');
			await setBackend('webgl');
		}
	}
	await ready();
	loaded = true;
}

const runPSD = async (samples: AccelSampleMs[]): Promise<PSDResult | null> => {
	await ready();
	const sampleRate = new BigNumber(samples.length)
		.div(new BigNumber(samples[samples.length - 1][0]).minus(samples[0][0]).shiftedBy(-3))
		.shiftedBy(-1)
		.decimalPlaces(0, BigNumber.ROUND_HALF_DOWN) // Round to closest 10's of Hz
		.shiftedBy(1)
		.toNumber();
	const tensors = tidy(() => {
		const signal = tensor2d(samples.map((s) => [s[1], s[2], s[3]]));
		const [x2d, y2d, z2d] = split<Tensor2D>(signal, 3, 1);
		const x = reshape<Rank.R1>(x2d, [x2d.shape[0]]);
		const y = reshape<Rank.R1>(y2d, [y2d.shape[0]]);
		const z = reshape<Rank.R1>(z2d, [z2d.shape[0]]);
		return { x, y, z };
	});
	try {
		const [xPsd, yPsd, zPsd] = await Promise.all([
			powerSpectralDensity(tensors.x, sampleRate, { isDetrended: true }),
			powerSpectralDensity(tensors.y, sampleRate, { isDetrended: true }),
			powerSpectralDensity(tensors.z, sampleRate, { isDetrended: true }),
		]);
		Object.values(tensors).forEach((t) => {
			t.dispose();
		});
		if (getBackend() === 'webgpu') {
			// Force cleanup of memory because tfjs sucks balls at memory management.
			const tf = backend() as WebGPUBackend;
			tf.bufferManager.dispose();
		} else if (getBackend() === 'webgl') {
			// Force cleanup of memory because tfjs sucks balls at memory management.
			const tf = backend() as MathBackendWebGL;
			const textureManager = tf.getTextureManager();
			textureManager.dispose();
			// I can't fucking believe it..
			(textureManager as any).freeTextures = {};
			(textureManager as any).usedTextures = {};
		}
		return {
			x: xPsd,
			y: yPsd,
			z: zPsd,
			total: sumPSDs([xPsd, yPsd, zPsd]),
		};
	} catch (e) {
		if (e instanceof WelchError) {
			return null;
		}
		throw e;
	}
};

export type AccumulateAndCallback = false | ((psd: Awaited<ReturnType<typeof runPSD>>) => void);

const createPSDProcessor = async (
	signal$: Observable<AccelSampleMs>,
	specSampleRate$: Observable<number>,
	accumulation$: Observable<AccumulateAndCallback>,
) => {
	const psdProcess = new Subject();
	const psdProcess$ = psdProcess.asObservable().pipe(shareReplay({ bufferSize: 1, refCount: false }));
	psdProcess$.subscribe();
	let first = true;
	if (typeof window !== 'undefined') {
		await loadTFJS();
	}
	return accumulation$.pipe(
		distinctUntilChanged(),
		switchScan(
			(acc, accumulate) => {
				if (accumulate) {
					return signal$.pipe(
						scan((sampleAcc, sample) => {
							sampleAcc.push(sample);
							return sampleAcc;
						}, [] as AccelSampleMs[]),
						filter((samples) => samples.length > 3200),
						map((samples) => {
							return {
								samples,
								onAccumulationComplete: accumulate,
								accumulationComplete: false,
							};
						}),
					);
				}
				if (!accumulate && acc.onAccumulationComplete) {
					acc.accumulationComplete = true;
					return of(acc);
				}
				// Don't accumulate
				return specSampleRate$.pipe(
					switchMap((sampleRate) => {
						return signal$.pipe(bufferFifo(sampleRate)); // Returns the last count(sampleRate) samples each time there's a new sample.
					}),
					map((samples) => {
						return {
							samples,
							onAccumulationComplete: false,
							accumulationComplete: false,
						};
					}),
				);
			},
			{
				samples: [] as AccelSampleMs[],
				onAccumulationComplete: false as AccumulateAndCallback,
				accumulationComplete: false,
			},
		),
		throttle(() => psdProcess$, { leading: first, trailing: true }),
		concatMap((input) => {
			const { samples, onAccumulationComplete, accumulationComplete } = input;
			if (first) {
				first = false;
			}
			return scheduled(
				from(
					runPSD(samples).then((psd) => {
						if (accumulationComplete && typeof onAccumulationComplete === 'function') {
							getLogger().info('Accumulation completed, psd was run on ' + samples.length + ' samples');
							onAccumulationComplete(psd);
							psdProcess.next({});
							return EMPTY;
						}
						if (psd == null) {
							psdProcess.next({});
							return EMPTY;
						}
						psdProcess.next({}); // Allow the next batch of samples through.
						return of(psd);
					}),
				),
				asyncScheduler,
			).pipe(mergeAll());
		}),
	);
};

export type PSDWorkerInput =
	| {
			command: 'sampleInput';
			payload: AccelSampleMs;
	  }
	| {
			command: 'specSampleRateInput';
			payload: number;
	  }
	| {
			command: 'accumulate';
			payload: boolean;
	  };
export type PSDWorkerOutput =
	| {
			type: 'accumulation_finished';
			psd: PSDResult;
	  }
	| {
			type: 'accumulation_started';
	  }
	| {
			type: 'psd';
			psd: PSDResult;
	  };
export class PSDWorker implements DoWork<PSDWorkerInput, PSDWorkerOutput> {
	private isAccumulating = false;
	private processor: ReturnType<typeof createPSDProcessor> | null = null;
	private signalPassThroughSubject = new Subject<AccelSampleMs>();
	private signalPassThrough$: Observable<AccelSampleMs> = this.signalPassThroughSubject.asObservable();
	private sampleRatePassThroughSubject = new Subject<number>();
	private sampleRatePassThrough$: Observable<number> = this.sampleRatePassThroughSubject
		.asObservable()
		.pipe(shareReplay({ bufferSize: 1, refCount: false }));
	private accumulationSubject = new Subject<AccumulateAndCallback>();
	private accumulation$ = this.accumulationSubject.asObservable().pipe(shareReplay({ bufferSize: 1, refCount: false }));
	public constructor() {
		this.signalPassThroughSubject = new Subject<AccelSampleMs>();
		this.signalPassThrough$ = this.signalPassThroughSubject.asObservable();
		this.sampleRatePassThroughSubject = new Subject<number>();
		this.sampleRatePassThrough$ = this.sampleRatePassThroughSubject
			.asObservable()
			.pipe(shareReplay({ bufferSize: 1, refCount: false }));
		this.sampleRatePassThrough$.subscribe();
		this.accumulationSubject = new Subject<AccumulateAndCallback>();
		this.accumulation$ = this.accumulationSubject.asObservable().pipe(shareReplay({ bufferSize: 1, refCount: false }));
	}
	public work(input$: Observable<PSDWorkerInput>) {
		return input$.pipe(
			mergeMap((input): Observable<PSDWorkerOutput> => {
				switch (input.command) {
					case 'accumulate': {
						if (!this.isAccumulating && input.payload === true) {
							getLogger().info('PSD Worker Command: Starting accumulation');
							this.isAccumulating = true;
							return merge(
								of({
									type: `accumulation_started` as const,
								}),
								scheduled(
									from(
										new Promise<PSDResult>((resolve, reject) => {
											this.accumulationSubject.next((val) => {
												if (val == null) {
													reject('Accumulation failed');
													return;
												}
												resolve(val);
											});
										}),
									).pipe(
										map((result) => {
											return {
												type: `accumulation_finished` as const,
												psd: result,
											};
										}),
									),
									asyncScheduler,
								),
							);
						} else {
							this.isAccumulating = false;
							this.accumulationSubject.next(false);
							// psdProcess.next({}); // this may still be necessary
							return EMPTY;
						}
					}
					case 'sampleInput': {
						this.signalPassThroughSubject.next(input.payload);
						if (this.processor == null) {
							this.processor = createPSDProcessor(
								this.signalPassThrough$,
								this.sampleRatePassThrough$,
								this.accumulation$,
							);
							const stream = from(this.processor).pipe(
								mergeMap((proc) =>
									proc.pipe(
										map(
											(psd) =>
												({
													type: 'psd',
													psd,
												}) as {
													type: 'psd';
													psd: PSDResult;
												},
										),
										shareReplay({ bufferSize: 1, refCount: false }),
									),
								),
							);
							firstValueFrom(from(this.processor)).then(() => {
								if (!this.isAccumulating) {
									this.accumulationSubject.next(false);
								}
							});
							return stream;
						}
						return EMPTY;
					}
					case 'specSampleRateInput': {
						if (!this.isAccumulating) {
							this.accumulationSubject.next(false);
						}
						this.sampleRatePassThroughSubject.next(input.payload);
						return EMPTY;
					}
					default: {
						return EMPTY;
					}
				}
			}),
		);
	}
	public selectTransferables(output: PSDWorkerOutput): Transferable[] {
		switch (output.type) {
			case 'psd': {
				return [
					output.psd.x.estimates.buffer,
					output.psd.x.frequencies.buffer,
					output.psd.y.estimates.buffer,
					output.psd.y.frequencies.buffer,
					output.psd.z.estimates.buffer,
					output.psd.z.frequencies.buffer,
					output.psd.total.estimates.buffer,
					output.psd.total.frequencies.buffer,
				];
			}
			case 'accumulation_finished': {
				return [
					output.psd.x.estimates.buffer,
					output.psd.x.frequencies.buffer,
					output.psd.y.estimates.buffer,
					output.psd.y.frequencies.buffer,
					output.psd.z.estimates.buffer,
					output.psd.z.frequencies.buffer,
					output.psd.total.estimates.buffer,
					output.psd.total.frequencies.buffer,
				];
			}
			default: {
				return [];
			}
		}
	}
}

runWorker(PSDWorker);
