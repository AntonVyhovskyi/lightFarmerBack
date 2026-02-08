import { getSigner } from "./client";
import dotenv from 'dotenv';
dotenv.config();

export async function updateOrder(marketIndex: number, orderIndex: number, baseAmount: number, price: number, triggerPrice: number) {
    const signer = await getSigner();
    try {
        const result = await signer.modifyOrder(marketIndex, orderIndex, baseAmount, price, triggerPrice);
        console.log('Good');
        console.log(result);
        
        
        return result;
    } catch (error) {
        console.error('Error updating order:', error);
    }
    
    
}



// Example usage:
// updateOrder(2049, 34058472247986096, 0, 13000, 15000).then((result) => {
//     console.log('Update Order Result:', result);
// }).catch((error) => {
//     console.error('Error updating order:', error);
// });