/**
 * 客户端本地类型补充：css-as-text 导入（scripts/build-client.mjs loader 配置，
 * esbuild 把 .css 当文本默认导出；宿主 loader 只 load JS，样式运行时注入）。
 */
declare module "*.css" {
  const content: string;
  export default content;
}
