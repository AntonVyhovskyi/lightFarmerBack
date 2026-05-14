export const o1Log = (tag: string, message: string, meta?: Record<string, unknown>) => {
  if (meta) {
    console.log(`[${tag}] ${message}`, meta);
    return;
  }
  console.log(`[${tag}] ${message}`);
};

export const o1Warn = (tag: string, message: string, meta?: Record<string, unknown>) => {
  if (meta) {
    console.warn(`[${tag}] ${message}`, meta);
    return;
  }
  console.warn(`[${tag}] ${message}`);
};

export const o1Error = (tag: string, message: string, meta?: Record<string, unknown>) => {
  if (meta) {
    console.error(`[${tag}] ${message}`, meta);
    return;
  }
  console.error(`[${tag}] ${message}`);
};
