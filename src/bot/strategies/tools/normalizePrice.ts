const normalizePrice = (price: string | number, coinIndex: number): string => {
    if (coinIndex !== 2) {
        return String(price);
    }

    const str = String(price).trim();

    const [intPartRaw, fracRaw] = str.split('.');

    // якщо ціла частина не число — стоп
    if (!/^\d+$/.test(intPartRaw)) {
        throw new Error(`Invalid price: ${price}`);
    }

    let fracPart = '000';

    // якщо після крапки є рівно 1–3 цифри — беремо
    if (fracRaw && /^\d{1,3}$/.test(fracRaw)) {
        fracPart = fracRaw.padEnd(3, '0');
    }

    return intPartRaw + fracPart;
};


console.log(normalizePrice('2132.123123123', 2));

