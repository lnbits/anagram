/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

export class CallConnection {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    close(reason?: string | null): void;
    end_reason(): string | undefined;
    recv(): Promise<Uint8Array>;
    send(data: Uint8Array): Promise<void>;
}

/**
 * An ephemeral identity. Never shared between calls or persisted.
 */
export class CallEndpoint {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    accept(peer_id: string, call_id: string): Promise<CallConnection>;
    close(): Promise<void>;
    connect(peer_id: string, relay_url: string, call_id: string): Promise<CallConnection>;
    static create(relay_url?: string | null): Promise<CallEndpoint>;
    static create_with_relays(urls: string[]): Promise<CallEndpoint>;
    id(): string;
    online(): Promise<void>;
    relay_url(): string;
}

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_callconnection_free: (a: number, b: number) => void;
    readonly __wbg_callendpoint_free: (a: number, b: number) => void;
    readonly callconnection_close: (a: number, b: number, c: number) => void;
    readonly callconnection_end_reason: (a: number, b: number) => void;
    readonly callconnection_recv: (a: number) => number;
    readonly callconnection_send: (a: number, b: number, c: number) => number;
    readonly callendpoint_accept: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly callendpoint_close: (a: number) => number;
    readonly callendpoint_connect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly callendpoint_create: (a: number, b: number) => number;
    readonly callendpoint_create_with_relays: (a: number, b: number) => number;
    readonly callendpoint_id: (a: number, b: number) => void;
    readonly callendpoint_online: (a: number) => number;
    readonly callendpoint_relay_url: (a: number, b: number) => void;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: number) => number;
    readonly intounderlyingbytesource_start: (a: number, b: number) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly intounderlyingsink_abort: (a: number, b: number) => number;
    readonly intounderlyingsink_close: (a: number) => number;
    readonly intounderlyingsink_write: (a: number, b: number) => number;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: number) => number;
    readonly __wasm_bindgen_func_elem_3692: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_3063: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_2307: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_2307_2: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_2307_3: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_4649: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_3841: (a: number, b: number) => void;
    readonly __wasm_bindgen_func_elem_1106: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number) => void;
    readonly __wbindgen_export5: (a: number, b: number, c: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
