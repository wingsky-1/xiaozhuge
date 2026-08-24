/**
 * write-file-atomic v8 最小本地类型面。
 *
 * 库未随包发布 .d.ts，社区 @types 停在 v4 回调风格 API（2023），与 v8
 * 不符——故按本仓实际用到的面自写声明（#29 第 A 项）。
 * 依据 node_modules/write-file-atomic/lib/index.js 实测：
 * 默认导出为原生 Promise 异步实现；options 字符串按 {encoding} 解析；
 * 附带 sync 导出。
 */
declare module "write-file-atomic" {
  interface WriteFileAtomicOptions {
    encoding?: BufferEncoding;
    mode?: number;
    signal?: AbortSignal;
    /** 落盘前 fsync 临时文件（默认 true）。 */
    fsync?: boolean;
  }

  function writeFileAtomic(
    file: string,
    data: string | Uint8Array,
    options?: WriteFileAtomicOptions | BufferEncoding,
  ): Promise<void>;

  namespace writeFileAtomic {
    function sync(
      file: string,
      data: string | Uint8Array,
      options?: WriteFileAtomicOptions | BufferEncoding,
    ): void;
  }

  export = writeFileAtomic;
}
