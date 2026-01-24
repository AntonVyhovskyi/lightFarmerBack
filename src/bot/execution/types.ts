export type ActionsTypes = { type: 'updateLeverage', options: { marketIndex: number, leverage: number } }
    | { type: 'closePosition', options: { marketIndex: number, quantity: number, size: boolean, price: number | string } } 
    | { type: 'openPosition', options: { marketIndex: number, quantity: number, size: boolean, price: number | string, slPrice: number | string } }
    | { type: 'trailingActive', options: { isActive: boolean } }
    | { type: 'beActive', options: { isActive: boolean } }
    | { type: 'updateOrder', options: { marketIndex: number, orderIndex: number, baseAmount: number, price: number, triggerPrice: number } };