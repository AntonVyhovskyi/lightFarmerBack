
import { OrderType, SymbolType } from "../../types";

export type ParamsTypeForStopLossTrailing = {
    trailingGapFromParams: number;
    position: number;
    symbol: SymbolType;
    orders: OrderType[];
    candle: string[];
    timeframe: "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "6h" | "8h" | "12h" | "1d";
}