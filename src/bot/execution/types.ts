export type ActionsTypes = { type: 'updateLeverage', options: { marketIndex: number, leverage: number } }
    | { type: 'closePosition', options: { marketIndex: number, quantity: number, size: boolean, price: number } } 
    | { type: 'openPosition', options: { marketIndex: number, quantity: number, size: boolean, price: number, slPrice: number } }
    | { type: 'trailingActive', options: { isActive: boolean } }
    | { type: 'beActive', options: { isActive: boolean } };