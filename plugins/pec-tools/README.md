# @pec/pec-tools

预装插件。随 profile `pec` 加载，无需安装。

## 文件

- `src/index.ts` 注册 7 个工具并安装 guard
- `src/tools/catalog.ts` 完整示例（含 provenance 与 render）
- `src/tools/business.ts` 6 个业务工具（execute 待实现）
- `src/policy/guard.ts` 租户校验示例
- `src/db.ts` 只读打开 pec.db，`src/errors.ts` 错误码

## 交付要求

1. 六个工具的 description 补全「适用 / 不适用」各一句。
2. 返回值统一 `{ data, provenance }`，provenance 到表 + 行 id。
3. 错误码只用四种，不要抛裸 Error。
4. 金额、体积用十进制库，禁止浮点累加。
5. 空实现会抛 `NOT_IMPLEMENTED`，评测时按未完成计。
