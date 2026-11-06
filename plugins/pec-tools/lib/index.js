import { installGuard } from "./policy/guard.js";
import { installToolSurface } from "./policy/tool-surface.js";
import { catalogTool } from "./tools/catalog.js";
import { orderLookup, supplierProfile, pricingQuote, freightCalc, contractSearch, ticketSimilar } from "./tools/business.js";
const name = "@pec/pec-tools";
const inject = ["tools"];
function apply(ctx) {
  for (const tool of [catalogTool, orderLookup, supplierProfile, pricingQuote, freightCalc, contractSearch, ticketSimilar]) {
    ctx.tools.register(tool);
  }
  installGuard(ctx);
  installToolSurface(ctx);
}
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
