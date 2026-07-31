/**
 * 应用设置读取的宿主无关抽象。
 *
 * - 普通设置:`store.getSetting(key)`。
 * - 加密设置:优先从 `process.env[envName]` 取(允许用户用环境变量覆盖,
 *   适配 worktree / CI / 容器注入场景),否则走 `LocalFileKeyStore` 解密。
 *
 * 业务编排模块(下沉的 review / delivery / merge-status)只依赖这个接口,
 * 不直接 import `TaskStore` / `LocalFileKeyStore`。
 */
export interface SettingResolver {
  /** 读取普通设置(明文存于 store)。 */
  get(key: string): string | undefined;
  /**
   * 读取加密设置。
   * @param key       加密存储的 setting key(如 `gitlabToken`)
   * @param envName   可选,环境变量名(优先从此处取)
   */
  getSecret(key: string, envName?: string): string | undefined;
}
