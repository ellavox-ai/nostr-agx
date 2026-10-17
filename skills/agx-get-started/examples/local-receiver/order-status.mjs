export const capability = 'demo.order-status';

export function orderStatus(payload) {
  const base = { source: 'agx-get-started-demo', demo: true };
  const orderId = payload?.orderId;
  if (typeof orderId !== 'string' || !/^DEMO-\d{4}$/.test(orderId)) {
    return { ...base, found: false, error: 'invalid-order-id' };
  }
  const orders = new Map([
    ['DEMO-1001', { status: 'ready-for-pickup', nextStep: 'Collect at the fictional demo warehouse.' }],
    ['DEMO-1002', { status: 'in-transit', nextStep: 'Check the fictional tracking record tomorrow.' }],
    ['DEMO-1003', { status: 'awaiting-review', nextStep: 'Ask the fictional demo operator to review the record.' }],
  ]);
  const record = orders.get(orderId);
  return record
    ? { ...base, orderId, found: true, ...record }
    : { ...base, found: false, error: 'order-not-found' };
}
