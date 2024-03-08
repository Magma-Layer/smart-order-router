"use strict";
//@ts-nocheck
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MixedRouteHeuristicGasModelFactory = void 0;
const bignumber_1 = require("@ethersproject/bignumber");
const router_sdk_1 = require("@uniswap/router-sdk");
const v2_sdk_1 = require("@uniswap/v2-sdk");
const v3_sdk_1 = require("@uniswap/v3-sdk");
const jsbi_1 = __importDefault(require("jsbi"));
const lodash_1 = __importDefault(require("lodash"));
const __1 = require("../../../..");
const util_1 = require("../../../../util");
const amounts_1 = require("../../../../util/amounts");
const gas_model_1 = require("../gas-model");
const v2_heuristic_gas_model_1 = require("../v2/v2-heuristic-gas-model");
const gas_costs_1 = require("../v3/gas-costs");
/**
 * Computes a gas estimate for a mixed route swap using heuristics.
 * Considers number of hops in the route, number of ticks crossed
 * and the typical base cost for a swap.
 *
 * We get the number of ticks crossed in a swap from the MixedRouteQuoterV1
 * contract.
 *
 * We compute gas estimates off-chain because
 *  1/ Calling eth_estimateGas for a swaps requires the caller to have
 *     the full balance token being swapped, and approvals.
 *  2/ Tracking gas used using a wrapper contract is not accurate with Multicall
 *     due to EIP-2929. We would have to make a request for every swap we wanted to estimate.
 *  3/ For V2 we simulate all our swaps off-chain so have no way to track gas used.
 *
 * @export
 * @class MixedRouteHeuristicGasModelFactory
 */
class MixedRouteHeuristicGasModelFactory extends gas_model_1.IOnChainGasModelFactory {
    constructor() {
        super();
    }
    async buildGasModel({ chainId, gasPriceWei, pools, quoteToken, v2poolProvider: V2poolProvider, providerConfig, }) {
        const usdPool = pools.usdPool;
        // If our quote token is WETH, we don't need to convert our gas use to be in terms
        // of the quote token in order to produce a gas adjusted amount.
        // We do return a gas use in USD however, so we still convert to usd.
        const nativeCurrency = __1.WRAPPED_NATIVE_CURRENCY[chainId];
        if (quoteToken.equals(nativeCurrency)) {
            const estimateGasCost = (routeWithValidQuote) => {
                const { totalGasCostNativeCurrency, baseGasUse } = this.estimateGas(routeWithValidQuote, gasPriceWei, chainId, providerConfig);
                const token0 = usdPool.token0.address == nativeCurrency.address;
                const nativeTokenPrice = token0
                    ? usdPool.token0Price
                    : usdPool.token1Price;
                const gasCostInTermsOfUSD = nativeTokenPrice.quote(totalGasCostNativeCurrency);
                return {
                    gasEstimate: baseGasUse,
                    gasCostInToken: totalGasCostNativeCurrency,
                    gasCostInUSD: gasCostInTermsOfUSD,
                };
            };
            return {
                estimateGasCost,
            };
        }
        // If the quote token is not in the native currency, we convert the gas cost to be in terms of the quote token.
        // We do this by getting the highest liquidity <quoteToken>/<nativeCurrency> pool. eg. <quoteToken>/ETH pool.
        const nativeV3Pool = pools.nativeQuoteTokenV3Pool;
        let nativeV2Pool;
        // if (V2poolProvider) {
        //   /// MixedRoutes
        //   nativeV2Pool = await getV2NativePool(
        //     quoteToken,
        //     V2poolProvider,
        //     providerConfig
        //   );
        // }
        const usdToken = usdPool.token0.address == nativeCurrency.address
            ? usdPool.token1
            : usdPool.token0;
        const estimateGasCost = (routeWithValidQuote) => {
            const { totalGasCostNativeCurrency, baseGasUse } = this.estimateGas(routeWithValidQuote, gasPriceWei, chainId, providerConfig);
            if (!nativeV3Pool && !nativeV2Pool) {
                util_1.log.info(`Unable to find ${nativeCurrency.symbol} pool with the quote token, ${quoteToken.symbol} to produce gas adjusted costs. Route will not account for gas.`);
                return {
                    gasEstimate: baseGasUse,
                    gasCostInToken: amounts_1.CurrencyAmount.fromRawAmount(quoteToken, 0),
                    gasCostInUSD: amounts_1.CurrencyAmount.fromRawAmount(usdToken, 0),
                };
            }
            /// we will use nativeV2Pool for fallback if nativeV3 does not exist or has 0 liquidity
            /// can use ! here because we return above if v3Pool and v2Pool are null
            const nativePool = (!nativeV3Pool || jsbi_1.default.equal(nativeV3Pool.liquidity, jsbi_1.default.BigInt(0))) &&
                nativeV2Pool
                ? nativeV2Pool
                : nativeV3Pool;
            const token0 = nativePool.token0.address == nativeCurrency.address;
            // returns mid price in terms of the native currency (the ratio of quoteToken/nativeToken)
            const nativeTokenPrice = token0
                ? nativePool.token0Price
                : nativePool.token1Price;
            let gasCostInTermsOfQuoteToken;
            try {
                // native token is base currency
                gasCostInTermsOfQuoteToken = nativeTokenPrice.quote(totalGasCostNativeCurrency);
            }
            catch (err) {
                util_1.log.info({
                    nativeTokenPriceBase: nativeTokenPrice.baseCurrency,
                    nativeTokenPriceQuote: nativeTokenPrice.quoteCurrency,
                    gasCostInEth: totalGasCostNativeCurrency.currency,
                }, 'Debug eth price token issue');
                throw err;
            }
            // true if token0 is the native currency
            const token0USDPool = usdPool.token0.address == nativeCurrency.address;
            // gets the mid price of the pool in terms of the native token
            const nativeTokenPriceUSDPool = token0USDPool
                ? usdPool.token0Price
                : usdPool.token1Price;
            let gasCostInTermsOfUSD;
            try {
                gasCostInTermsOfUSD = nativeTokenPriceUSDPool.quote(totalGasCostNativeCurrency);
            }
            catch (err) {
                util_1.log.info({
                    usdT1: usdPool.token0.symbol,
                    usdT2: usdPool.token1.symbol,
                    gasCostInNativeToken: totalGasCostNativeCurrency.currency.symbol,
                }, 'Failed to compute USD gas price');
                throw err;
            }
            return {
                gasEstimate: baseGasUse,
                gasCostInToken: gasCostInTermsOfQuoteToken,
                gasCostInUSD: gasCostInTermsOfUSD,
            };
        };
        return {
            estimateGasCost: estimateGasCost.bind(this),
        };
    }
    estimateGas(routeWithValidQuote, gasPriceWei, chainId, providerConfig) {
        const totalInitializedTicksCrossed = bignumber_1.BigNumber.from(Math.max(1, lodash_1.default.sum(routeWithValidQuote.initializedTicksCrossedList)));
        /**
         * Since we must make a separate call to multicall for each v3 and v2 section, we will have to
         * add the BASE_SWAP_COST to each section.
         */
        let baseGasUse = bignumber_1.BigNumber.from(0);
        const route = routeWithValidQuote.route;
        const res = (0, router_sdk_1.partitionMixedRouteByProtocol)(route);
        res.map((section) => {
            if (section.every((pool) => pool instanceof v3_sdk_1.Pool)) {
                baseGasUse = baseGasUse.add((0, gas_costs_1.BASE_SWAP_COST)(chainId));
                baseGasUse = baseGasUse.add((0, gas_costs_1.COST_PER_HOP)(chainId).mul(section.length));
            }
            else if (section.every((pool) => pool instanceof v2_sdk_1.Pair)) {
                baseGasUse = baseGasUse.add(v2_heuristic_gas_model_1.BASE_SWAP_COST);
                baseGasUse = baseGasUse.add(
                /// same behavior in v2 heuristic gas model factory
                v2_heuristic_gas_model_1.COST_PER_EXTRA_HOP.mul(section.length - 1));
            }
        });
        const tickGasUse = (0, gas_costs_1.COST_PER_INIT_TICK)(chainId).mul(totalInitializedTicksCrossed);
        const uninitializedTickGasUse = gas_costs_1.COST_PER_UNINIT_TICK.mul(0);
        // base estimate gas used based on chainId estimates for hops and ticks gas useage
        baseGasUse = baseGasUse.add(tickGasUse).add(uninitializedTickGasUse);
        if (providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.additionalGasOverhead) {
            baseGasUse = baseGasUse.add(providerConfig.additionalGasOverhead);
        }
        const baseGasCostWei = gasPriceWei.mul(baseGasUse);
        const wrappedCurrency = __1.WRAPPED_NATIVE_CURRENCY[chainId];
        const totalGasCostNativeCurrency = amounts_1.CurrencyAmount.fromRawAmount(wrappedCurrency, baseGasCostWei.toString());
        return {
            totalGasCostNativeCurrency,
            totalInitializedTicksCrossed,
            baseGasUse,
        };
    }
}
exports.MixedRouteHeuristicGasModelFactory = MixedRouteHeuristicGasModelFactory;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWl4ZWQtcm91dGUtaGV1cmlzdGljLWdhcy1tb2RlbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uLy4uL3NyYy9yb3V0ZXJzL2FscGhhLXJvdXRlci9nYXMtbW9kZWxzL21peGVkUm91dGUvbWl4ZWQtcm91dGUtaGV1cmlzdGljLWdhcy1tb2RlbC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUEsYUFBYTs7Ozs7O0FBRWIsd0RBQXFEO0FBQ3JELG9EQUFvRTtBQUVwRSw0Q0FBdUM7QUFDdkMsNENBQXVDO0FBQ3ZDLGdEQUF3QjtBQUN4QixvREFBdUI7QUFFdkIsbUNBQXNEO0FBRXRELDJDQUF1QztBQUN2QyxzREFBMEQ7QUFFMUQsNENBSXNCO0FBQ3RCLHlFQUdzQztBQUN0QywrQ0FLeUI7QUFFekI7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBaUJHO0FBQ0gsTUFBYSxrQ0FBbUMsU0FBUSxtQ0FBdUI7SUFDN0U7UUFDRSxLQUFLLEVBQUUsQ0FBQztJQUNWLENBQUM7SUFFTSxLQUFLLENBQUMsYUFBYSxDQUFDLEVBQ3pCLE9BQU8sRUFDUCxXQUFXLEVBQ1gsS0FBSyxFQUNMLFVBQVUsRUFDVixjQUFjLEVBQUUsY0FBYyxFQUM5QixjQUFjLEdBQ2tCO1FBR2hDLE1BQU0sT0FBTyxHQUFTLEtBQUssQ0FBQyxPQUFPLENBQUM7UUFFcEMsa0ZBQWtGO1FBQ2xGLGdFQUFnRTtRQUNoRSxxRUFBcUU7UUFDckUsTUFBTSxjQUFjLEdBQUcsMkJBQXVCLENBQUMsT0FBTyxDQUFFLENBQUM7UUFDekQsSUFBSSxVQUFVLENBQUMsTUFBTSxDQUFDLGNBQWMsQ0FBQyxFQUFFO1lBQ3JDLE1BQU0sZUFBZSxHQUFHLENBQ3RCLG1CQUE2QyxFQUs3QyxFQUFFO2dCQUNGLE1BQU0sRUFBRSwwQkFBMEIsRUFBRSxVQUFVLEVBQUUsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUNqRSxtQkFBbUIsRUFDbkIsV0FBVyxFQUNYLE9BQU8sRUFDUCxjQUFjLENB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