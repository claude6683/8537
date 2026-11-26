import { jobs } from './api.mjs';
export default async () => { await jobs.simRefresh(); };
export const config = { schedule: '5 */6 * * *' };
