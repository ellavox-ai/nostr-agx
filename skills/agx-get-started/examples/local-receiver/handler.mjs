import { appendFileSync } from 'node:fs';
import { capability, orderStatus } from './order-status.mjs';

export default {
  [capability]: (payload, task) => {
    const output = orderStatus(payload);
    if (process.env.DEMO_AUDIT_PATH) {
      appendFileSync(process.env.DEMO_AUDIT_PATH, JSON.stringify({ taskId: task.taskId, output }) + '\n', { mode: 0o600 });
    }
    return output;
  },
};
