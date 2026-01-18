
import { OrderType, SymbolType } from "../../types";

export type ParamsTypeForConservativeStrategy = {
    emaShortPeriod: number;
    emaLongPeriod: number;
    atrPeriod: number;
    atrRange: number;
    riskPct: number;
    atrPctforSL: number;
    trailStartFromParams: number;
    trailGapFromParams: number;
    leverage: number;
    bePrc: number;
    balance: {total: number, avaliable: number};
    candles: string[][];
    timeframe: "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "8h" | "12h" | "1d";
    position: number;
    symbol: SymbolType;
    orders: OrderType[];
}