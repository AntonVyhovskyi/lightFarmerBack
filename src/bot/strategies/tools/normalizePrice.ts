export const normalizePrice = (price: string | number, coinIndex: number): number => {
    if (coinIndex !== 2 && coinIndex !== 120) {
        return Number(price);
    }

    const str = String(price).trim();

    let [intPartRaw, fracRaw] = str.split('.');

    if (!fracRaw) {
        if (coinIndex === 120) {
            fracRaw = '0000';
        } else {
            fracRaw = '000';
        }
      
    }

    // якщо ціла частина не число — стоп
    if (!/^\d+$/.test(intPartRaw)) {
        throw new Error(`Invalid price: ${price}`);
    }

    let fracPart = (fracRaw.split('')[0] ? fracRaw.split('')[0] : '0') + (fracRaw.split('')[1] ? fracRaw.split('')[1] : '0') + (fracRaw.split('')[2] ? fracRaw.split('')[2] : '0');

   if (coinIndex === 120) {
        fracPart += (fracRaw.split('')[3] ? fracRaw.split('')[3] : '0');
    }

    return Number(intPartRaw + fracPart);
};


// console.log(normalizePrice(126.62325, 2));

