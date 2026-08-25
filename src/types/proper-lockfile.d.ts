/**
 * proper-lockfile v4 最小本地类型面（本仓仅用异步 lock/unlock；
 * 库未随包发布 .d.ts，社区 @types 与本仓用法不符故自写，#29 第 C 项）。
 */
declare module "proper-lockfile" {
  interface LockOptions {
    /** staleness 阈值 ms（库内最小 clamp 到 2000；适配层取大值禁用自动 steal）。 */
    stale?: number;
    /** mtime 续期间隔 ms；缺省为 stale/2（unref 定时器）。 */
    update?: number | null;
    realpath?: boolean;
    retries?: number | { retries: number };
    onCompromised?: (err: Error) => void;
  }

  export function lock(file: string, options?: LockOptions): Promise<() => Promise<void>>;
  export function unlock(file: string): Promise<void>;
  export function check(file: string, options?: { stale?: number }): Promise<boolean>;
}
