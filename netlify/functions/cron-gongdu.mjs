import { jobs } from './api.mjs';
export default async () => {
  const h = new Date().getUTCHours();
  if (h === 22) await jobs.gongduBuild(); else await jobs.gongduExtras();
};
export const config = { schedule: '0 1-23/3 * * *' };
