import { ParamsForSomeStrategy } from './strategies/types';
import { ActionsTypes } from "./execution/types";
import { ParamsTypeForConservativeStrategy } from "./strategies/conservativeEma/types";

export type SymbolType = {
    name: "ETH",
    index: 0
} | {
    name: "BTC",
    index: 1
} | {
    name: "SOL",
    index: 2
};


export type StartOptionsType = Omit<ParamsTypeForConservativeStrategy,  'position' | 'balance' | 'orders' | 'candles'> & {
    strategyFunc: (p:ParamsForSomeStrategy)=> ActionsTypes[];
  };
export type OptionsForEngine = ParamsTypeForConservativeStrategy

export type OrderType = {
    order_index: number;
    client_order_index: number;
    order_id: string;
    client_order_id: string;
    market_index: number;
    owner_account_index: number;
    initial_base_amount: string;
    price: string;
    nonce: number;
    remaining_base_amount: string;
    is_ask: boolean;
    base_size: number;
    base_price: number;
    filled_base_amount: string;
    filled_quote_amount: string;
    side: string;
    type: 'limit' | 'market';
    time_in_force: 'good-till-time' | 'immediate-or-cancel' | 'fill-or-kill';
    reduce_only: boolean;
    trigger_price: string;
    order_expiry: number;
    status: 'open' | 'filled' | 'canceled' | 'partial';
    trigger_status: 'na' | 'pending' | 'triggered';
    trigger_time: number;
    parent_order_index: number;
    parent_order_id: string;
    to_trigger_order_id_0: string;
    to_trigger_order_id_1: string;
    to_cancel_order_id_0: string;
    block_height: number;
    timestamp: number;
    created_at: number;
    updated_at: number;
    transaction_time: number;
};