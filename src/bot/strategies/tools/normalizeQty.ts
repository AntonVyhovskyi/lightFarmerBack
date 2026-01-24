export const normalizeQty = (qty: number, coinIndex: number): number => {
    if (coinIndex !== 2) {
        return Math.floor(qty * 1000);
    }
    return Math.floor(qty * 1000);

}