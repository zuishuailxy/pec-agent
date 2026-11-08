import { installGuard } from "./policy/guard.js";
import { installToolSurface } from "./policy/tool-surface.js";
import { installToolBoundary } from "./policy/tool-boundary.js";
import { installMemoryInjection } from "./memory/inject.js";
import { catalogTool } from "./tools/catalog.js";
import { orderLookup, supplierProfile, pricingQuote, freightCalc, contractSearch, ticketSimilar, adviceCard, memoryRecall, memoryRemember, memoryForget, skillWrite } from "./tools/business.js";
const name = "@pec/pec-tools";
const inject = ["tools"];
function apply(ctx) {
  for (const tool of [
    catalogTool,
    orderLookup,
    supplierProfile,
    pricingQuote,
    freightCalc,
    contractSearch,
    ticketSimilar,
    adviceCard,
    memoryRecall,
    memoryRemember,
    memoryForget,
    skillWrite
  ]) {
    ctx.tools.register(tool);
  }
  installGuard(ctx);
  installToolSurface(ctx);
  installToolBoundary(ctx);
  installMemoryInjection(ctx);
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
