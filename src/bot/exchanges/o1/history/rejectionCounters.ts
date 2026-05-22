export type O1RejectionCounters = {
  noCross: number;
  crossFound: number;
  strengthRejected: number;
  cooldownRejected: number;
  qtyZeroRejected: number;
  blockNewEntriesRejected: number;
  emergencyStopRejected: number;
  orderRejected: number;
  positionNotConfirmed: number;
  enteredConfirmed: number;
};

const counters: O1RejectionCounters = {
  noCross: 0,
  crossFound: 0,
  strengthRejected: 0,
  cooldownRejected: 0,
  qtyZeroRejected: 0,
  blockNewEntriesRejected: 0,
  emergencyStopRejected: 0,
  orderRejected: 0,
  positionNotConfirmed: 0,
  enteredConfirmed: 0,
};

export const incrementRejection = (key: keyof O1RejectionCounters, amount = 1): void => {
  counters[key] += amount;
};

export const getRejectionCounters = (): O1RejectionCounters => ({ ...counters });

export const resetRejectionCounters = (): void => {
  for (const key of Object.keys(counters) as (keyof O1RejectionCounters)[]) {
    counters[key] = 0;
  }
};
