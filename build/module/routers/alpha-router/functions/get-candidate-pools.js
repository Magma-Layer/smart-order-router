import { Protocol } from '@uniswap/router-sdk';
import { ChainId, TradeType } from '@uniswap/sdk-core';
import { FeeAmount } from '@uniswap/v3-sdk';
import _ from 'lodash';
import { CELO, CELO_ALFAJORES, CEUR_CELO, CEUR_CELO_ALFAJORES, CUSD_CELO, CUSD_CELO_ALFAJORES, DAI_ARBITRUM, DAI_AVAX, DAI_BNB, DAI_MAINNET, DAI_MOONBEAM, DAI_OPTIMISM, DAI_OPTIMISM_GOERLI, DAI_POLYGON_MUMBAI, DAI_SEPOLIA, FEI_MAINNET, USDC_ARBITRUM, USDC_ARBITRUM_GOERLI, USDC_AVAX, USDC_BASE, USDC_BNB, USDC_ETHEREUM_GNOSIS, USDC_MAINNET, USDC_MOONBEAM, USDC_OPTIMISM, USDC_OPTIMISM_GOERLI, USDC_POLYGON, USDC_SEPOLIA, USDT_ARBITRUM, USDT_BNB, USDT_MAINNET, USDT_OPTIMISM, USDT_OPTIMISM_GOERLI, WBTC_ARBITRUM, WBTC_GNOSIS, WBTC_MAINNET, WBTC_MOONBEAM, WBTC_OPTIMISM, WBTC_OPTIMISM_GOERLI, WGLMR_MOONBEAM, WMATIC_POLYGON, WMATIC_POLYGON_MUMBAI, WXDAI_GNOSIS, } from '../../../providers/token-provider';
import { unparseFeeAmount, WRAPPED_NATIVE_CURRENCY } from '../../../util';
import { parseFeeAmount } from '../../../util/amounts';
import { log } from '../../../util/log';
import { metric, MetricLoggerUnit } from '../../../util/metric';
const baseTokensByChain = {
    [ChainId.MAINNET]: [
        USDC_MAINNET,
        USDT_MAINNET,
        WBTC_MAINNET,
        DAI_MAINNET,
        WRAPPED_NATIVE_CURRENCY[1],
        FEI_MAINNET,
    ],
    [ChainId.OPTIMISM]: [
        DAI_OPTIMISM,
        USDC_OPTIMISM,
        USDT_OPTIMISM,
        WBTC_OPTIMISM,
    ],
    [ChainId.SEPOLIA]: [
        DAI_SEPOLIA,
        USDC_SEPOLIA,
    ],
    [ChainId.OPTIMISM_GOERLI]: [
        DAI_OPTIMISM_GOERLI,
        USDC_OPTIMISM_GOERLI,
        USDT_OPTIMISM_GOERLI,
        WBTC_OPTIMISM_GOERLI,
    ],
    [ChainId.ARBITRUM_ONE]: [
        DAI_ARBITRUM,
        USDC_ARBITRUM,
        WBTC_ARBITRUM,
        USDT_ARBITRUM,
    ],
    [ChainId.ARBITRUM_GOERLI]: [USDC_ARBITRUM_GOERLI],
    [ChainId.POLYGON]: [USDC_POLYGON, WMATIC_POLYGON],
    [ChainId.POLYGON_MUMBAI]: [DAI_POLYGON_MUMBAI, WMATIC_POLYGON_MUMBAI],
    [ChainId.CELO]: [CUSD_CELO, CEUR_CELO, CELO],
    [ChainId.CELO_ALFAJORES]: [
        CUSD_CELO_ALFAJORES,
        CEUR_CELO_ALFAJORES,
        CELO_ALFAJORES,
    ],
    [ChainId.GNOSIS]: [WBTC_GNOSIS, WXDAI_GNOSIS, USDC_ETHEREUM_GNOSIS],
    [ChainId.MOONBEAM]: [
        DAI_MOONBEAM,
        USDC_MOONBEAM,
        WBTC_MOONBEAM,
        WGLMR_MOONBEAM,
    ],
    [ChainId.BNB]: [
        DAI_BNB,
        USDC_BNB,
        USDT_BNB,
    ],
    [ChainId.AVALANCHE]: [
        DAI_AVAX,
        USDC_AVAX,
    ],
    [ChainId.BASE]: [
        USDC_BASE,
    ],
};
class SubcategorySelectionPools {
    constructor(pools, poolsNeeded) {
        this.pools = pools;
        this.poolsNeeded = poolsNeeded;
    }
    hasEnoughPools() {
        return this.pools.length >= this.poolsNeeded;
    }
}
export async function getV3CandidatePools({ tokenIn, tokenOut, routeType, routingConfig, subgraphProvider, tokenProvider, poolProvider, blockedTokenListProvider, chainId, }) {
    var _a, _b, _c, _d, _e;
    const { blockNumber, v3PoolSelection: { topN, topNDirectSwaps, topNTokenInOut, topNSecondHop, topNSecondHopForTokenAddress, tokensToAvoidOnSecondHops, topNWithEachBaseToken, topNWithBaseToken, }, } = routingConfig;
    const tokenInAddress = tokenIn.address.toLowerCase();
    const tokenOutAddress = tokenOut.address.toLowerCase();
    const beforeSubgraphPools = Date.now();
    const allPools = await subgraphProvider.getPools(tokenIn, tokenOut, {
        blockNumber,
    });
    log.info({ samplePools: allPools.slice(0, 3) }, 'Got all pools from V3 subgraph provider');
    // Although this is less of an optimization than the V2 equivalent,
    // save some time copying objects by mutating the underlying pool directly.
    for (const pool of allPools) {
        pool.token0.id = pool.token0.id.toLowerCase();
        pool.token1.id = pool.token1.id.toLowerCase();
    }
    metric.putMetric('V3SubgraphPoolsLoad', Date.now() - beforeSubgraphPools, MetricLoggerUnit.Milliseconds);
    const beforePoolsFiltered = Date.now();
    // Only consider pools where neither tokens are in the blocked token list.
    let filteredPools = allPools;
    if (blockedTokenListProvider) {
        filteredPools = [];
        for (const pool of allPools) {
            const token0InBlocklist = await blockedTokenListProvider.hasTokenByAddress(pool.token0.id);
            const token1InBlocklist = await blockedTokenListProvider.hasTokenByAddress(pool.token1.id);
            if (token0InBlocklist || token1InBlocklist) {
                continue;
            }
            filteredPools.push(pool);
        }
    }
    // Sort by tvlUSD in descending order
    const subgraphPoolsSorted = filteredPools.sort((a, b) => b.tvlUSD - a.tvlUSD);
    log.info(`After filtering blocked tokens went from ${allPools.length} to ${subgraphPoolsSorted.length}.`);
    const poolAddressesSoFar = new Set();
    const addToAddressSet = (pools) => {
        _(pools)
            .map((pool) => pool.id)
            .forEach((poolAddress) => poolAddressesSoFar.add(poolAddress));
    };
    const baseTokens = (_a = baseTokensByChain[chainId]) !== null && _a !== void 0 ? _a : [];
    const topByBaseWithTokenIn = _(baseTokens)
        .flatMap((token) => {
        return _(subgraphPoolsSorted)
            .filter((subgraphPool) => {
            const tokenAddress = token.address.toLowerCase();
            return ((subgraphPool.token0.id == tokenAddress &&
                subgraphPool.token1.id == tokenInAddress) ||
                (subgraphPool.token1.id == tokenAddress &&
                    subgraphPool.token0.id == tokenInAddress));
        })
            .sortBy((tokenListPool) => -tokenListPool.tvlUSD)
            .slice(0, topNWithEachBaseToken)
            .value();
    })
        .sortBy((tokenListPool) => -tokenListPool.tvlUSD)
        .slice(0, topNWithBaseToken)
        .value();
    const topByBaseWithTokenOut = _(baseTokens)
        .flatMap((token) => {
        return _(subgraphPoolsSorted)
            .filter((subgraphPool) => {
            const tokenAddress = token.address.toLowerCase();
            return ((subgraphPool.token0.id == tokenAddress &&
                subgraphPool.token1.id == tokenOutAddress) ||
                (subgraphPool.token1.id == tokenAddress &&
                    subgraphPool.token0.id == tokenOutAddress));
        })
            .sortBy((tokenListPool) => -tokenListPool.tvlUSD)
            .slice(0, topNWithEachBaseToken)
            .value();
    })
        .sortBy((tokenListPool) => -tokenListPool.tvlUSD)
        .slice(0, topNWithBaseToken)
        .value();
    let top2DirectSwapPool = _(subgraphPoolsSorted)
        .filter((subgraphPool) => {
        return (!poolAddressesSoFar.has(subgraphPool.id) &&
            ((subgraphPool.token0.id == tokenInAddress &&
                subgraphPool.token1.id == tokenOutAddress) ||
                (subgraphPool.token1.id == tokenInAddress &&
                    subgraphPool.token0.id == tokenOutAddress)));
    })
        .slice(0, topNDirectSwaps)
        .value();
    if (top2DirectSwapPool.length == 0 && topNDirectSwaps > 0) {
        // If we requested direct swap pools but did not find any in the subgraph query.
        // Optimistically add them into the query regardless. Invalid pools ones will be dropped anyway
        // when we query the pool on-chain. Ensures that new pools for new pairs can be swapped on immediately.
        top2DirectSwapPool = _.map([FeeAmount.HIGH, FeeAmount.MEDIUM, FeeAmount.LOW, FeeAmount.LOWEST], (feeAmount) => {
            const { token0, token1, poolAddress } = poolProvider.getPoolAddress(tokenIn, tokenOut, feeAmount);
            return {
                id: poolAddress,
                feeTier: unparseFeeAmount(feeAmount),
                liquidity: '10000',
                token0: {
                    id: token0.address,
                },
                token1: {
                    id: token1.address,
                },
                tvlETH: 10000,
                tvlUSD: 10000,
            };
        });
    }
    addToAddressSet(top2DirectSwapPool);
    const wrappedNativeAddress = (_b = WRAPPED_NATIVE_CURRENCY[chainId]) === null || _b === void 0 ? void 0 : _b.address.toLowerCase();
    // Main reason we need this is for gas estimates, only needed if token out is not native.
    // We don't check the seen address set because if we've already added pools for getting native quotes
    // theres no need to add more.
    let top2EthQuoteTokenPool = [];
    if ((((_c = WRAPPED_NATIVE_CURRENCY[chainId]) === null || _c === void 0 ? void 0 : _c.symbol) ==
        ((_d = WRAPPED_NATIVE_CURRENCY[ChainId.MAINNET]) === null || _d === void 0 ? void 0 : _d.symbol) &&
        tokenOut.symbol != 'WETH' &&
        tokenOut.symbol != 'WETH9' &&
        tokenOut.symbol != 'ETH') ||
        (((_e = WRAPPED_NATIVE_CURRENCY[chainId]) === null || _e === void 0 ? void 0 : _e.symbol) == WMATIC_POLYGON.symbol &&
            tokenOut.symbol != 'MATIC' &&
            tokenOut.symbol != 'WMATIC')) {
        top2EthQuoteTokenPool = _(subgraphPoolsSorted)
            .filter((subgraphPool) => {
            if (routeType == TradeType.EXACT_INPUT) {
                return ((subgraphPool.token0.id == wrappedNativeAddress &&
                    subgraphPool.token1.id == tokenOutAddress) ||
                    (subgraphPool.token1.id == wrappedNativeAddress &&
                        subgraphPool.token0.id == tokenOutAddress));
            }
            else {
                return ((subgraphPool.token0.id == wrappedNativeAddress &&
                    subgraphPool.token1.id == tokenInAddress) ||
                    (subgraphPool.token1.id == wrappedNativeAddress &&
                        subgraphPool.token0.id == tokenInAddress));
            }
        })
            .slice(0, 1)
            .value();
    }
    addToAddressSet(top2EthQuoteTokenPool);
    const topByTVL = _(subgraphPoolsSorted)
        .filter((subgraphPool) => {
        return !poolAddressesSoFar.has(subgraphPool.id);
    })
        .slice(0, topN)
        .value();
    addToAddressSet(topByTVL);
    const topByTVLUsingTokenIn = _(subgraphPoolsSorted)
        .filter((subgraphPool) => {
        return (!poolAddressesSoFar.has(subgraphPool.id) &&
            (subgraphPool.token0.id == tokenInAddress ||
                subgraphPool.token1.id == tokenInAddress));
    })
        .slice(0, topNTokenInOut)
        .value();
    addToAddressSet(topByTVLUsingTokenIn);
    const topByTVLUsingTokenOut = _(subgraphPoolsSorted)
        .filter((subgraphPool) => {
        return (!poolAddressesSoFar.has(subgraphPool.id) &&
            (subgraphPool.token0.id == tokenOutAddress ||
                subgraphPool.token1.id == tokenOutAddress));
    })
        .slice(0, topNTokenInOut)
        .value();
    addToAddressSet(topByTVLUsingTokenOut);
    const topByTVLUsingTokenInSecondHops = _(topByTVLUsingTokenIn)
        .map((subgraphPool) => {
        return tokenInAddress == subgraphPool.token0.id
            ? subgraphPool.token1.id
            : subgraphPool.token0.id;
    })
        .flatMap((secondHopId) => {
        var _a;
        return _(subgraphPoolsSorted)
            .filter((subgraphPool) => {
            return (!poolAddressesSoFar.has(subgraphPool.id) &&
                !(tokensToAvoidOnSecondHops === null || tokensToAvoidOnSecondHops === void 0 ? void 0 : tokensToAvoidOnSecondHops.includes(secondHopId.toLowerCase())) &&
                (subgraphPool.token0.id == secondHopId ||
                    subgraphPool.token1.id == secondHopId));
        })
            .slice(0, (_a = topNSecondHopForTokenAddress === null || topNSecondHopForTokenAddress === void 0 ? void 0 : topNSecondHopForTokenAddress.get(secondHopId)) !== null && _a !== void 0 ? _a : topNSecondHop)
            .value();
    })
        .uniqBy((pool) => pool.id)
        .value();
    addToAddressSet(topByTVLUsingTokenInSecondHops);
    const topByTVLUsingTokenOutSecondHops = _(topByTVLUsingTokenOut)
        .map((subgraphPool) => {
        return tokenOutAddress == subgraphPool.token0.id
            ? subgraphPool.token1.id
            : subgraphPool.token0.id;
    })
        .flatMap((secondHopId) => {
        var _a;
        return _(subgraphPoolsSorted)
            .filter((subgraphPool) => {
            return (!poolAddressesSoFar.has(subgraphPool.id) &&
                !(tokensToAvoidOnSecondHops === null || tokensToAvoidOnSecondHops === void 0 ? void 0 : tokensToAvoidOnSecondHops.includes(secondHopId.toLowerCase())) &&
                (subgraphPool.token0.id == secondHopId ||
                    subgraphPool.token1.id == secondHopId));
        })
            .slice(0, (_a = topNSecondHopForTokenAddress === null || topNSecondHopForTokenAddress === void 0 ? void 0 : topNSecondHopForTokenAddress.get(secondHopId)) !== null && _a !== void 0 ? _a : topNSecondHop)
            .value();
    })
        .uniqBy((pool) => pool.id)
        .value();
    addToAddressSet(topByTVLUsingTokenOutSecondHops);
    const subgraphPools = _([
        ...topByBaseWithTokenIn,
        ...topByBaseWithTokenOut,
        ...top2DirectSwapPool,
        ...top2EthQuoteTokenPool,
        ...topByTVL,
        ...topByTVLUsingTokenIn,
        ...topByTVLUsingTokenOut,
        ...topByTVLUsingTokenInSecondHops,
        ...topByTVLUsingTokenOutSecondHops,
    ])
        .compact()
        .uniqBy((pool) => pool.id)
        .value();
    const tokenAddresses = _(subgraphPools)
        .flatMap((subgraphPool) => [subgraphPool.token0.id, subgraphPool.token1.id])
        .compact()
        .uniq()
        .value();
    log.info(`Getting the ${tokenAddresses.length} tokens within the ${subgraphPools.length} V3 pools we are considering`);
    const tokenAccessor = await tokenProvider.getTokens(tokenAddresses, {
        blockNumber,
    });
    const printV3SubgraphPool = (s) => {
        var _a, _b, _c, _d;
        return `${(_b = (_a = tokenAccessor.getTokenByAddress(s.token0.id)) === null || _a === void 0 ? void 0 : _a.symbol) !== null && _b !== void 0 ? _b : s.token0.id}/${(_d = (_c = tokenAccessor.getTokenByAddress(s.token1.id)) === null || _c === void 0 ? void 0 : _c.symbol) !== null && _d !== void 0 ? _d : s.token1.id}/${s.feeTier}`;
    };
    log.info({
        topByBaseWithTokenIn: topByBaseWithTokenIn.map(printV3SubgraphPool),
        topByBaseWithTokenOut: topByBaseWithTokenOut.map(printV3SubgraphPool),
        topByTVL: topByTVL.map(printV3SubgraphPool),
        topByTVLUsingTokenIn: topByTVLUsingTokenIn.map(printV3SubgraphPool),
        topByTVLUsingTokenOut: topByTVLUsingTokenOut.map(printV3SubgraphPool),
        topByTVLUsingTokenInSecondHops: topByTVLUsingTokenInSecondHops.map(printV3SubgraphPool),
        topByTVLUsingTokenOutSecondHops: topByTVLUsingTokenOutSecondHops.map(printV3SubgraphPool),
        top2DirectSwap: top2DirectSwapPool.map(printV3SubgraphPool),
        top2EthQuotePool: top2EthQuoteTokenPool.map(printV3SubgraphPool),
    }, `V3 Candidate Pools`);
    const tokenPairsRaw = _.map(subgraphPools, (subgraphPool) => {
        const tokenA = tokenAccessor.getTokenByAddress(subgraphPool.token0.id);
        const tokenB = tokenAccessor.getTokenByAddress(subgraphPool.token1.id);
        let fee;
        try {
            fee = parseFeeAmount(subgraphPool.feeTier);
        }
        catch (err) {
            log.info({ subgraphPool }, `Dropping candidate pool for ${subgraphPool.token0.id}/${subgraphPool.token1.id}/${subgraphPool.feeTier} because fee tier not supported`);
            return undefined;
        }
        if (!tokenA || !tokenB) {
            log.info(`Dropping candidate pool for ${subgraphPool.token0.id}/${subgraphPool.token1.id}/${fee} because ${tokenA ? subgraphPool.token1.id : subgraphPool.token0.id} not found by token provider`);
            return undefined;
        }
        return [tokenA, tokenB, fee];
    });
    const tokenPairs = _.compact(tokenPairsRaw);
    metric.putMetric('V3PoolsFilterLoad', Date.now() - beforePoolsFiltered, MetricLoggerUnit.Milliseconds);
    const beforePoolsLoad = Date.now();
    const poolAccessor = await poolProvider.getPools(tokenPairs, {
        blockNumber,
    });
    metric.putMetric('V3PoolsLoad', Date.now() - beforePoolsLoad, MetricLoggerUnit.Milliseconds);
    const poolsBySelection = {
        protocol: Protocol.V3,
        selections: {
            topByBaseWithTokenIn,
            topByBaseWithTokenOut,
            topByDirectSwapPool: top2DirectSwapPool,
            topByEthQuoteTokenPool: top2EthQuoteTokenPool,
            topByTVL,
            topByTVLUsingTokenIn,
            topByTVLUsingTokenOut,
            topByTVLUsingTokenInSecondHops,
            topByTVLUsingTokenOutSecondHops,
        },
    };
    return { poolAccessor, candidatePools: poolsBySelection, subgraphPools };
}
export async function getV2CandidatePools({ tokenIn, tokenOut, routeType, routingConfig, subgraphProvider, tokenProvider, poolProvider, blockedTokenListProvider, chainId, }) {
    var _a;
    const { blockNumber, v2PoolSelection: { topN, topNDirectSwaps, topNTokenInOut, topNSecondHop, tokensToAvoidOnSecondHops, topNWithEachBaseToken, topNWithBaseToken, }, } = routingConfig;
    const tokenInAddress = tokenIn.address.toLowerCase();
    const tokenOutAddress = tokenOut.address.toLowerCase();
    const beforeSubgraphPools = Date.now();
    const allPoolsRaw = await subgraphProvider.getPools(tokenIn, tokenOut, {
        blockNumber,
    });
    // With tens of thousands of V2 pools, operations that copy pools become costly.
    // Mutate the pool directly rather than creating a new pool / token to optimmize for speed.
    for (const pool of allPoolsRaw) {
        pool.token0.id = pool.token0.id.toLowerCase();
        pool.token1.id = pool.token1.id.toLowerCase();
    }
    metric.putMetric('V2SubgraphPoolsLoad', Date.now() - beforeSubgraphPools, MetricLoggerUnit.Milliseconds);
    const beforePoolsFiltered = Date.now();
    // Sort by pool reserve in descending order.
    const subgraphPoolsSorted = allPoolsRaw.sort((a, b) => b.reserve - a.reserve);
    const poolAddressesSoFar = new Set();
    // Always add the direct swap pool into the mix regardless of if it exists in the subgraph pool list.
    // Ensures that new pools can be swapped on immediately, and that if a pool was filtered out of the
    // subgraph query for some reason (e.g. trackedReserveETH was 0), then we still consider it.
    let topByDirectSwapPool = [];
    if (topNDirectSwaps > 0) {
        const { token0, token1, poolAddress } = poolProvider.getPoolAddress(tokenIn, tokenOut);
        poolAddressesSoFar.add(poolAddress.toLowerCase());
        topByDirectSwapPool = [
            {
                id: poolAddress,
                token0: {
                    id: token0.address,
                },
                token1: {
                    id: token1.address,
                },
                supply: 10000,
                reserve: 10000,
                reserveUSD: 10000, // Not used. Set to arbitrary number.
            },
        ];
    }
    const wethAddress = WRAPPED_NATIVE_CURRENCY[chainId].address.toLowerCase();
    const topByBaseWithTokenInMap = new Map();
    const topByBaseWithTokenOutMap = new Map();
    const baseTokens = (_a = baseTokensByChain[chainId]) !== null && _a !== void 0 ? _a : [];
    const baseTokensAddresses = new Set();
    baseTokens.forEach((token) => {
        const baseTokenAddr = token.address.toLowerCase();
        baseTokensAddresses.add(baseTokenAddr);
        topByBaseWithTokenInMap.set(baseTokenAddr, new SubcategorySelectionPools([], topNWithEachBaseToken));
        topByBaseWithTokenOutMap.set(baseTokenAddr, new SubcategorySelectionPools([], topNWithEachBaseToken));
    });
    let topByBaseWithTokenInPoolsFound = 0;
    let topByBaseWithTokenOutPoolsFound = 0;
    // Main reason we need this is for gas estimates
    // There can ever only be 1 Token/ETH pool, so we will only look for 1
    let topNEthQuoteToken = 1;
    // but, we only need it if token out is not ETH.
    if (tokenOut.symbol == 'WETH' || tokenOut.symbol == 'WETH9' || tokenOut.symbol == 'ETH') {
        // if it's eth we change the topN to 0, so we can break early from the loop.
        topNEthQuoteToken = 0;
    }
    const topByEthQuoteTokenPool = [];
    const topByTVLUsingTokenIn = [];
    const topByTVLUsingTokenOut = [];
    const topByTVL = [];
    // Used to track how many iterations we do in the first loop
    let loopsInFirstIteration = 0;
    // Filtering step for up to first hop
    // The pools are pre-sorted, so we can just iterate through them and fill our heuristics.
    for (const subgraphPool of subgraphPoolsSorted) {
        loopsInFirstIteration += 1;
        // Check if we have satisfied all the heuristics, if so, we can stop.
        if (topByBaseWithTokenInPoolsFound >= topNWithBaseToken &&
            topByBaseWithTokenOutPoolsFound >= topNWithBaseToken &&
            topByEthQuoteTokenPool.length >= topNEthQuoteToken &&
            topByTVL.length >= topN &&
            topByTVLUsingTokenIn.length >= topNTokenInOut &&
            topByTVLUsingTokenOut.length >= topNTokenInOut) {
            // We have satisfied all the heuristics, so we can stop.
            break;
        }
        if (poolAddressesSoFar.has(subgraphPool.id)) {
            // We've already added this pool, so skip it.
            continue;
        }
        // Only consider pools where neither tokens are in the blocked token list.
        if (blockedTokenListProvider) {
            const [token0InBlocklist, token1InBlocklist] = await Promise.all([
                blockedTokenListProvider.hasTokenByAddress(subgraphPool.token0.id),
                blockedTokenListProvider.hasTokenByAddress(subgraphPool.token1.id)
            ]);
            if (token0InBlocklist || token1InBlocklist) {
                continue;
            }
        }
        const tokenInToken0TopByBase = topByBaseWithTokenInMap.get(subgraphPool.token0.id);
        if (topByBaseWithTokenInPoolsFound < topNWithBaseToken &&
            tokenInToken0TopByBase &&
            subgraphPool.token0.id != tokenOutAddress &&
            subgraphPool.token1.id == tokenInAddress) {
            topByBaseWithTokenInPoolsFound += 1;
            poolAddressesSoFar.add(subgraphPool.id);
            if (topByTVLUsingTokenIn.length < topNTokenInOut) {
                topByTVLUsingTokenIn.push(subgraphPool);
            }
            if (routeType === TradeType.EXACT_OUTPUT && subgraphPool.token0.id == wethAddress) {
                topByEthQuoteTokenPool.push(subgraphPool);
            }
            tokenInToken0TopByBase.pools.push(subgraphPool);
            continue;
        }
        const tokenInToken1TopByBase = topByBaseWithTokenInMap.get(subgraphPool.token1.id);
        if (topByBaseWithTokenInPoolsFound < topNWithBaseToken &&
            tokenInToken1TopByBase &&
            subgraphPool.token0.id == tokenInAddress &&
            subgraphPool.token1.id != tokenOutAddress) {
            topByBaseWithTokenInPoolsFound += 1;
            poolAddressesSoFar.add(subgraphPool.id);
            if (topByTVLUsingTokenIn.length < topNTokenInOut) {
                topByTVLUsingTokenIn.push(subgraphPool);
            }
            if (routeType === TradeType.EXACT_OUTPUT && subgraphPool.token1.id == wethAddress) {
                topByEthQuoteTokenPool.push(subgraphPool);
            }
            tokenInToken1TopByBase.pools.push(subgraphPool);
            continue;
        }
        const tokenOutToken0TopByBase = topByBaseWithTokenOutMap.get(subgraphPool.token0.id);
        if (topByBaseWithTokenOutPoolsFound < topNWithBaseToken &&
            tokenOutToken0TopByBase &&
            subgraphPool.token0.id != tokenInAddress &&
            subgraphPool.token1.id == tokenOutAddress) {
            topByBaseWithTokenOutPoolsFound += 1;
            poolAddressesSoFar.add(subgraphPool.id);
            if (topByTVLUsingTokenOut.length < topNTokenInOut) {
                topByTVLUsingTokenOut.push(subgraphPool);
            }
            if (routeType === TradeType.EXACT_INPUT && subgraphPool.token0.id == wethAddress) {
                topByEthQuoteTokenPool.push(subgraphPool);
            }
            tokenOutToken0TopByBase.pools.push(subgraphPool);
            continue;
        }
        const tokenOutToken1TopByBase = topByBaseWithTokenOutMap.get(subgraphPool.token1.id);
        if (topByBaseWithTokenOutPoolsFound < topNWithBaseToken &&
            tokenOutToken1TopByBase &&
            subgraphPool.token0.id == tokenOutAddress &&
            subgraphPool.token1.id != tokenInAddress) {
            topByBaseWithTokenOutPoolsFound += 1;
            poolAddressesSoFar.add(subgraphPool.id);
            if (topByTVLUsingTokenOut.length < topNTokenInOut) {
                topByTVLUsingTokenOut.push(subgraphPool);
            }
            if (routeType === TradeType.EXACT_INPUT && subgraphPool.token1.id == wethAddress) {
                topByEthQuoteTokenPool.push(subgraphPool);
            }
            tokenOutToken1TopByBase.pools.push(subgraphPool);
            continue;
        }
        // Note: we do not need to check other native currencies for the V2 Protocol
        if (topByEthQuoteTokenPool.length < topNEthQuoteToken &&
            (routeType === TradeType.EXACT_INPUT && ((subgraphPool.token0.id == wethAddress && subgraphPool.token1.id == tokenOutAddress) ||
                (subgraphPool.token1.id == wethAddress && subgraphPool.token0.id == tokenOutAddress)) ||
                routeType === TradeType.EXACT_OUTPUT && ((subgraphPool.token0.id == wethAddress && subgraphPool.token1.id == tokenInAddress) ||
                    (subgraphPool.token1.id == wethAddress && subgraphPool.token0.id == tokenInAddress)))) {
            poolAddressesSoFar.add(subgraphPool.id);
            topByEthQuoteTokenPool.push(subgraphPool);
            continue;
        }
        if (topByTVL.length < topN) {
            poolAddressesSoFar.add(subgraphPool.id);
            topByTVL.push(subgraphPool);
            continue;
        }
        if (topByTVLUsingTokenIn.length < topNTokenInOut &&
            (subgraphPool.token0.id == tokenInAddress || subgraphPool.token1.id == tokenInAddress)) {
            poolAddressesSoFar.add(subgraphPool.id);
            topByTVLUsingTokenIn.push(subgraphPool);
            continue;
        }
        if (topByTVLUsingTokenOut.length < topNTokenInOut &&
            (subgraphPool.token0.id == tokenOutAddress || subgraphPool.token1.id == tokenOutAddress)) {
            poolAddressesSoFar.add(subgraphPool.id);
            topByTVLUsingTokenOut.push(subgraphPool);
            continue;
        }
    }
    metric.putMetric('V2SubgraphLoopsInFirstIteration', loopsInFirstIteration, MetricLoggerUnit.Count);
    const topByBaseWithTokenIn = [];
    for (const topByBaseWithTokenInSelection of topByBaseWithTokenInMap.values()) {
        topByBaseWithTokenIn.push(...topByBaseWithTokenInSelection.pools);
    }
    const topByBaseWithTokenOut = [];
    for (const topByBaseWithTokenOutSelection of topByBaseWithTokenOutMap.values()) {
        topByBaseWithTokenOut.push(...topByBaseWithTokenOutSelection.pools);
    }
    // Filtering step for second hops
    const topByTVLUsingTokenInSecondHopsMap = new Map();
    const topByTVLUsingTokenOutSecondHopsMap = new Map();
    const tokenInSecondHopAddresses = topByTVLUsingTokenIn.filter((pool) => {
        // filtering second hops
        if (tokenInAddress === pool.token0.id) {
            return !(tokensToAvoidOnSecondHops === null || tokensToAvoidOnSecondHops === void 0 ? void 0 : tokensToAvoidOnSecondHops.includes(pool.token1.id.toLowerCase()));
        }
        else {
            return !(tokensToAvoidOnSecondHops === null || tokensToAvoidOnSecondHops === void 0 ? void 0 : tokensToAvoidOnSecondHops.includes(pool.token0.id.toLowerCase()));
        }
    }).map((pool) => tokenInAddress === pool.token0.id ? pool.token1.id : pool.token0.id);
    const tokenOutSecondHopAddresses = topByTVLUsingTokenOut.filter((pool) => {
        // filtering second hops
        if (tokenOutAddress === pool.token0.id) {
            return !(tokensToAvoidOnSecondHops === null || tokensToAvoidOnSecondHops === void 0 ? void 0 : tokensToAvoidOnSecondHops.includes(pool.token1.id.toLowerCase()));
        }
        else {
            return !(tokensToAvoidOnSecondHops === null || tokensToAvoidOnSecondHops === void 0 ? void 0 : tokensToAvoidOnSecondHops.includes(pool.token0.id.toLowerCase()));
        }
    }).map((pool) => tokenOutAddress === pool.token0.id ? pool.token1.id : pool.token0.id);
    for (const secondHopId of tokenInSecondHopAddresses) {
        topByTVLUsingTokenInSecondHopsMap.set(secondHopId, new SubcategorySelectionPools([], topNSecondHop));
    }
    for (const secondHopId of tokenOutSecondHopAddresses) {
        topByTVLUsingTokenOutSecondHopsMap.set(secondHopId, new SubcategorySelectionPools([], topNSecondHop));
    }
    // Used to track how many iterations we do in the second loop
    let loopsInSecondIteration = 0;
    if (tokenInSecondHopAddresses.length > 0 || tokenOutSecondHopAddresses.length > 0) {
        for (const subgraphPool of subgraphPoolsSorted) {
            loopsInSecondIteration += 1;
            let allTokenInSecondHopsHaveTheirTopN = true;
            for (const secondHopPools of topByTVLUsingTokenInSecondHopsMap.values()) {
                if (!secondHopPools.hasEnoughPools()) {
                    allTokenInSecondHopsHaveTheirTopN = false;
                    break;
                }
            }
            let allTokenOutSecondHopsHaveTheirTopN = true;
            for (const secondHopPools of topByTVLUsingTokenOutSecondHopsMap.values()) {
                if (!secondHopPools.hasEnoughPools()) {
                    allTokenOutSecondHopsHaveTheirTopN = false;
                    break;
                }
            }
            if (allTokenInSecondHopsHaveTheirTopN && allTokenOutSecondHopsHaveTheirTopN) {
                // We have satisfied all the heuristics, so we can stop.
                break;
            }
            if (poolAddressesSoFar.has(subgraphPool.id)) {
                continue;
            }
            // Only consider pools where neither tokens are in the blocked token list.
            if (blockedTokenListProvider) {
                const [token0InBlocklist, token1InBlocklist] = await Promise.all([
                    blockedTokenListProvider.hasTokenByAddress(subgraphPool.token0.id),
                    blockedTokenListProvider.hasTokenByAddress(subgraphPool.token1.id)
                ]);
                if (token0InBlocklist || token1InBlocklist) {
                    continue;
                }
            }
            const tokenInToken0SecondHop = topByTVLUsingTokenInSecondHopsMap.get(subgraphPool.token0.id);
            if (tokenInToken0SecondHop && !tokenInToken0SecondHop.hasEnoughPools()) {
                poolAddressesSoFar.add(subgraphPool.id);
                tokenInToken0SecondHop.pools.push(subgraphPool);
                continue;
            }
            const tokenInToken1SecondHop = topByTVLUsingTokenInSecondHopsMap.get(subgraphPool.token1.id);
            if (tokenInToken1SecondHop && !tokenInToken1SecondHop.hasEnoughPools()) {
                poolAddressesSoFar.add(subgraphPool.id);
                tokenInToken1SecondHop.pools.push(subgraphPool);
                continue;
            }
            const tokenOutToken0SecondHop = topByTVLUsingTokenOutSecondHopsMap.get(subgraphPool.token0.id);
            if (tokenOutToken0SecondHop && !tokenOutToken0SecondHop.hasEnoughPools()) {
                poolAddressesSoFar.add(subgraphPool.id);
                tokenOutToken0SecondHop.pools.push(subgraphPool);
                continue;
            }
            const tokenOutToken1SecondHop = topByTVLUsingTokenOutSecondHopsMap.get(subgraphPool.token1.id);
            if (tokenOutToken1SecondHop && !tokenOutToken1SecondHop.hasEnoughPools()) {
                poolAddressesSoFar.add(subgraphPool.id);
                tokenOutToken1SecondHop.pools.push(subgraphPool);
                continue;
            }
        }
    }
    metric.putMetric('V2SubgraphLoopsInSecondIteration', loopsInSecondIteration, MetricLoggerUnit.Count);
    const topByTVLUsingTokenInSecondHops = [];
    for (const secondHopPools of topByTVLUsingTokenInSecondHopsMap.values()) {
        topByTVLUsingTokenInSecondHops.push(...secondHopPools.pools);
    }
    const topByTVLUsingTokenOutSecondHops = [];
    for (const secondHopPools of topByTVLUsingTokenOutSecondHopsMap.values()) {
        topByTVLUsingTokenOutSecondHops.push(...secondHopPools.pools);
    }
    const subgraphPools = _([
        ...topByBaseWithTokenIn,
        ...topByBaseWithTokenOut,
        ...topByDirectSwapPool,
        ...topByEthQuoteTokenPool,
        ...topByTVL,
        ...topByTVLUsingTokenIn,
        ...topByTVLUsingTokenOut,
        ...topByTVLUsingTokenInSecondHops,
        ...topByTVLUsingTokenOutSecondHops,
    ])
        .uniqBy((pool) => pool.id)
        .value();
    const tokenAddressesSet = new Set();
    for (const pool of subgraphPools) {
        tokenAddressesSet.add(pool.token0.id);
        tokenAddressesSet.add(pool.token1.id);
    }
    const tokenAddresses = Array.from(tokenAddressesSet);
    log.info(`Getting the ${tokenAddresses.length} tokens within the ${subgraphPools.length} V2 pools we are considering`);
    const tokenAccessor = await tokenProvider.getTokens(tokenAddresses, {
        blockNumber,
    });
    const printV2SubgraphPool = (s) => {
        var _a, _b, _c, _d;
        return `${(_b = (_a = tokenAccessor.getTokenByAddress(s.token0.id)) === null || _a === void 0 ? void 0 : _a.symbol) !== null && _b !== void 0 ? _b : s.token0.id}/${(_d = (_c = tokenAccessor.getTokenByAddress(s.token1.id)) === null || _c === void 0 ? void 0 : _c.symbol) !== null && _d !== void 0 ? _d : s.token1.id}`;
    };
    log.info({
        topByBaseWithTokenIn: topByBaseWithTokenIn.map(printV2SubgraphPool),
        topByBaseWithTokenOut: topByBaseWithTokenOut.map(printV2SubgraphPool),
        topByTVL: topByTVL.map(printV2SubgraphPool),
        topByTVLUsingTokenIn: topByTVLUsingTokenIn.map(printV2SubgraphPool),
        topByTVLUsingTokenOut: topByTVLUsingTokenOut.map(printV2SubgraphPool),
        topByTVLUsingTokenInSecondHops: topByTVLUsingTokenInSecondHops.map(printV2SubgraphPool),
        topByTVLUsingTokenOutSecondHops: topByTVLUsingTokenOutSecondHops.map(printV2SubgraphPool),
        top2DirectSwap: topByDirectSwapPool.map(printV2SubgraphPool),
        top2EthQuotePool: topByEthQuoteTokenPool.map(printV2SubgraphPool),
    }, `V2 Candidate pools`);
    const tokenPairsRaw = _.map(subgraphPools, (subgraphPool) => {
        const tokenA = tokenAccessor.getTokenByAddress(subgraphPool.token0.id);
        const tokenB = tokenAccessor.getTokenByAddress(subgraphPool.token1.id);
        if (!tokenA || !tokenB) {
            log.info(`Dropping candidate pool for ${subgraphPool.token0.id}/${subgraphPool.token1.id}`);
            return undefined;
        }
        return [tokenA, tokenB];
    });
    const tokenPairs = _.compact(tokenPairsRaw);
    metric.putMetric('V2PoolsFilterLoad', Date.now() - beforePoolsFiltered, MetricLoggerUnit.Milliseconds);
    const beforePoolsLoad = Date.now();
    // this should be the only place to enable fee-on-transfer fee fetching,
    // because this places loads pools (pairs of tokens with fot taxes) from the subgraph
    const poolAccessor = await poolProvider.getPools(tokenPairs, routingConfig);
    metric.putMetric('V2PoolsLoad', Date.now() - beforePoolsLoad, MetricLoggerUnit.Milliseconds);
    const poolsBySelection = {
        protocol: Protocol.V2,
        selections: {
            topByBaseWithTokenIn,
            topByBaseWithTokenOut,
            topByDirectSwapPool,
            topByEthQuoteTokenPool,
            topByTVL,
            topByTVLUsingTokenIn,
            topByTVLUsingTokenOut,
            topByTVLUsingTokenInSecondHops,
            topByTVLUsingTokenOutSecondHops,
        },
    };
    return { poolAccessor, candidatePools: poolsBySelection, subgraphPools };
}
export async function getMixedRouteCandidatePools({ v3CandidatePools, v2CandidatePools, routingConfig, tokenProvider, v3poolProvider, v2poolProvider, }) {
    const beforeSubgraphPools = Date.now();
    const [{ subgraphPools: V3subgraphPools, candidatePools: V3candidatePools }, { subgraphPools: V2subgraphPools, candidatePools: V2candidatePools }] = [v3CandidatePools, v2CandidatePools];
    metric.putMetric('MixedSubgraphPoolsLoad', Date.now() - beforeSubgraphPools, MetricLoggerUnit.Milliseconds);
    const beforePoolsFiltered = Date.now();
    /**
     * Main heuristic for pruning mixedRoutes:
     * - we pick V2 pools with higher liq than respective V3 pools, or if the v3 pool doesn't exist
     *
     * This way we can reduce calls to our provider since it's possible to generate a lot of mixed routes
     */
    /// We only really care about pools involving the tokenIn or tokenOut explictly,
    /// since there's no way a long tail token in V2 would be routed through as an intermediary
    const V2topByTVLPoolIds = new Set([
        ...V2candidatePools.selections.topByTVLUsingTokenIn,
        ...V2candidatePools.selections.topByBaseWithTokenIn,
        /// tokenOut:
        ...V2candidatePools.selections.topByTVLUsingTokenOut,
        ...V2candidatePools.selections.topByBaseWithTokenOut,
        /// Direct swap:
        ...V2candidatePools.selections.topByDirectSwapPool,
    ].map((poolId) => poolId.id));
    const V2topByTVLSortedPools = _(V2subgraphPools)
        .filter((pool) => V2topByTVLPoolIds.has(pool.id))
        .sortBy((pool) => -pool.reserveUSD)
        .value();
    /// we consider all returned V3 pools for this heuristic to "fill in the gaps"
    const V3sortedPools = _(V3subgraphPools)
        .sortBy((pool) => -pool.tvlUSD)
        .value();
    /// Finding pools with greater reserveUSD on v2 than tvlUSD on v3, or if there is no v3 liquidity
    const buildV2Pools = [];
    V2topByTVLSortedPools.forEach((V2subgraphPool) => {
        const V3subgraphPool = V3sortedPools.find((pool) => (pool.token0.id == V2subgraphPool.token0.id &&
            pool.token1.id == V2subgraphPool.token1.id) ||
            (pool.token0.id == V2subgraphPool.token1.id &&
                pool.token1.id == V2subgraphPool.token0.id));
        if (V3subgraphPool) {
            if (V2subgraphPool.reserveUSD > V3subgraphPool.tvlUSD) {
                log.info({
                    token0: V2subgraphPool.token0.id,
                    token1: V2subgraphPool.token1.id,
                    v2reserveUSD: V2subgraphPool.reserveUSD,
                    v3tvlUSD: V3subgraphPool.tvlUSD,
                }, `MixedRoute heuristic, found a V2 pool with higher liquidity than its V3 counterpart`);
                buildV2Pools.push(V2subgraphPool);
            }
        }
        else {
            log.info({
                token0: V2subgraphPool.token0.id,
                token1: V2subgraphPool.token1.id,
                v2reserveUSD: V2subgraphPool.reserveUSD,
            }, `MixedRoute heuristic, found a V2 pool with no V3 counterpart`);
            buildV2Pools.push(V2subgraphPool);
        }
    });
    log.info(buildV2Pools.length, `Number of V2 candidate pools that fit first heuristic`);
    const subgraphPools = [...buildV2Pools, ...V3sortedPools];
    const tokenAddresses = _(subgraphPools)
        .flatMap((subgraphPool) => [subgraphPool.token0.id, subgraphPool.token1.id])
        .compact()
        .uniq()
        .value();
    log.info(`Getting the ${tokenAddresses.length} tokens within the ${subgraphPools.length} pools we are considering`);
    const tokenAccessor = await tokenProvider.getTokens(tokenAddresses, routingConfig);
    const V3tokenPairsRaw = _.map(V3sortedPools, (subgraphPool) => {
        const tokenA = tokenAccessor.getTokenByAddress(subgraphPool.token0.id);
        const tokenB = tokenAccessor.getTokenByAddress(subgraphPool.token1.id);
        let fee;
        try {
            fee = parseFeeAmount(subgraphPool.feeTier);
        }
        catch (err) {
            log.info({ subgraphPool }, `Dropping candidate pool for ${subgraphPool.token0.id}/${subgraphPool.token1.id}/${subgraphPool.feeTier} because fee tier not supported`);
            return undefined;
        }
        if (!tokenA || !tokenB) {
            log.info(`Dropping candidate pool for ${subgraphPool.token0.id}/${subgraphPool.token1.id}/${fee} because ${tokenA ? subgraphPool.token1.id : subgraphPool.token0.id} not found by token provider`);
            return undefined;
        }
        return [tokenA, tokenB, fee];
    });
    const V3tokenPairs = _.compact(V3tokenPairsRaw);
    const V2tokenPairsRaw = _.map(buildV2Pools, (subgraphPool) => {
        const tokenA = tokenAccessor.getTokenByAddress(subgraphPool.token0.id);
        const tokenB = tokenAccessor.getTokenByAddress(subgraphPool.token1.id);
        if (!tokenA || !tokenB) {
            log.info(`Dropping candidate pool for ${subgraphPool.token0.id}/${subgraphPool.token1.id}`);
            return undefined;
        }
        return [tokenA, tokenB];
    });
    const V2tokenPairs = _.compact(V2tokenPairsRaw);
    metric.putMetric('MixedPoolsFilterLoad', Date.now() - beforePoolsFiltered, MetricLoggerUnit.Milliseconds);
    const beforePoolsLoad = Date.now();
    const [V2poolAccessor, V3poolAccessor] = await Promise.all([
        v2poolProvider.getPools(V2tokenPairs, routingConfig),
        v3poolProvider.getPools(V3tokenPairs, routingConfig),
    ]);
    metric.putMetric('MixedPoolsLoad', Date.now() - beforePoolsLoad, MetricLoggerUnit.Milliseconds);
    /// @dev a bit tricky here since the original V2CandidateSelections object included pools that we may have dropped
    /// as part of the heuristic. We need to reconstruct a new object with the v3 pools too.
    const buildPoolsBySelection = (key) => {
        return [
            ...buildV2Pools.filter((pool) => V2candidatePools.selections[key].map((p) => p.id).includes(pool.id)),
            ...V3candidatePools.selections[key],
        ];
    };
    const poolsBySelection = {
        protocol: Protocol.MIXED,
        selections: {
            topByBaseWithTokenIn: buildPoolsBySelection('topByBaseWithTokenIn'),
            topByBaseWithTokenOut: buildPoolsBySelection('topByBaseWithTokenOut'),
            topByDirectSwapPool: buildPoolsBySelection('topByDirectSwapPool'),
            topByEthQuoteTokenPool: buildPoolsBySelection('topByEthQuoteTokenPool'),
            topByTVL: buildPoolsBySelection('topByTVL'),
            topByTVLUsingTokenIn: buildPoolsBySelection('topByTVLUsingTokenIn'),
            topByTVLUsingTokenOut: buildPoolsBySelection('topByTVLUsingTokenOut'),
            topByTVLUsingTokenInSecondHops: buildPoolsBySelection('topByTVLUsingTokenInSecondHops'),
            topByTVLUsingTokenOutSecondHops: buildPoolsBySelection('topByTVLUsingTokenOutSecondHops'),
        },
    };
    return {
        V2poolAccessor,
        V3poolAccessor,
        candidatePools: poolsBySelection,
        subgraphPools,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2V0LWNhbmRpZGF0ZS1wb29scy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9yb3V0ZXJzL2FscGhhLXJvdXRlci9mdW5jdGlvbnMvZ2V0LWNhbmRpZGF0ZS1wb29scy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsUUFBUSxFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFDL0MsT0FBTyxFQUFFLE9BQU8sRUFBUyxTQUFTLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUM5RCxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDNUMsT0FBTyxDQUFDLE1BQU0sUUFBUSxDQUFDO0FBR3ZCLE9BQU8sRUFDTCxJQUFJLEVBQ0osY0FBYyxFQUNkLFNBQVMsRUFDVCxtQkFBbUIsRUFDbkIsU0FBUyxFQUNULG1CQUFtQixFQUNuQixZQUFZLEVBQ1osUUFBUSxFQUNSLE9BQU8sRUFDUCxXQUFXLEVBQ1gsWUFBWSxFQUNaLFlBQVksRUFDWixtQkFBbUIsRUFDbkIsa0JBQWtCLEVBQ2xCLFdBQVcsRUFDWCxXQUFXLEVBRVgsYUFBYSxFQUNiLG9CQUFvQixFQUNwQixTQUFTLEVBQ1QsU0FBUyxFQUNULFFBQVEsRUFDUixvQkFBb0IsRUFDcEIsWUFBWSxFQUNaLGFBQWEsRUFDYixhQUFhLEVBQ2Isb0JBQW9CLEVBQ3BCLFlBQVksRUFDWixZQUFZLEVBQ1osYUFBYSxFQUNiLFFBQVEsRUFDUixZQUFZLEVBQ1osYUFBYSxFQUNiLG9CQUFvQixFQUNwQixhQUFhLEVBQ2IsV0FBVyxFQUNYLFlBQVksRUFDWixhQUFhLEVBQ2IsYUFBYSxFQUNiLG9CQUFvQixFQUNwQixjQUFjLEVBQ2QsY0FBYyxFQUNkLHFCQUFxQixFQUNyQixZQUFZLEdBQ2IsTUFBTSxtQ0FBbUMsQ0FBQztBQUkzQyxPQUFPLEVBQUUsZ0JBQWdCLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSxlQUFlLENBQUM7QUFDMUUsT0FBTyxF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