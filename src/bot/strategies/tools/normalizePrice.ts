export const normalizePrice = (price: string | number, coinIndex: number): number => {
    if (coinIndex !== 2) {
        return Number(price);
    }

    const str = String(price).trim();

    const [intPartRaw, fracRaw] = str.split('.');

    // якщо ціла частина не число — стоп
    if (!/^\d+$/.test(intPartRaw)) {
        throw new Error(`Invalid price: ${price}`);
    }

    let fracPart = (fracRaw.split('')[0] ? fracRaw.split('')[0] : '0') + (fracRaw.split('')[1] ? fracRaw.split('')[1] : '0') + (fracRaw.split('')[2] ? fracRaw.split('')[2] : '0');

   

    return Number(intPartRaw + fracPart);
};


// console.log(normalizePrice(126.62325, 2));

