import { getSigner } from "./client";

export async function changeLeverage(marketIndex: number, leverage: number) {
    try {
        const signer = await getSigner();
        const data = await signer.updateLeverage(marketIndex, 0, leverage);
        return data;
    } catch (error) {
        return error;
    }


}


// Example usage:
// changeLeverage(2, 5).then(() => {
//     console.log('Leverage change request completed.');
// }).catch((error) => {
//     console.error('Error changing leverage:', error);
// });
