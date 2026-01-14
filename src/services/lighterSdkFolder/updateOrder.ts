import { getSigner } from "./client";

export async function updateOrder(marketIndex: number, orderIndex: number, baseAmount: number, price: number, triggerPrice: number) {
    const signer = await getSigner();
    const result = await signer.modifyOrder(marketIndex, orderIndex, baseAmount, price, triggerPrice);
    return result;
}



// Example usage:
updateOrder(2, 844425510731696, 977, 147000, 0).then((result) => {
    console.log('Update Order Result:', result);
}).catch((error) => {
    console.error('Error updating order:', error);
});