import { jobs } from './api.mjs';
export default async () => { await jobs.fagRecord(); };
export const config = { schedule: '*/5 * * * *' };
