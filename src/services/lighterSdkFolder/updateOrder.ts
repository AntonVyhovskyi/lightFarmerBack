import { getSigner } from "./client";
import dotenv from 'dotenv';
dotenv.config();

export async function updateOrder(marketIndex: number, orderIndex: number, baseAmount: number, price: number, triggerPrice: number) {
    const signer = await getSigner();
    try {
        const result = await signer.modifyOrder(marketIndex, orderIndex, baseAmount, price, triggerPrice);
        return result;
    } catch (error) {
        console.error('Error updating order:', error);
    }
    
    
}



// // Example usage:
// updateOrder(2, 844425536424560, 343, 108000, 117000).then((result) => {
//     console.log('Update Order Result:', result);
// }).catch((error) => {
//     console.error('Error updating order:', error);
// });