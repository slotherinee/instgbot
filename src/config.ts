export const BOT_TAG = "@instg_save_bot";
export const LOCAL_BOT_API_URL = Bun.env.LOCAL_BOT_API_URL || "https://api.telegram.org";
export const ADMIN_USERNAME = Bun.env.ADMIN_USERNAME!;
export const ADMIN_USER_IDS = [324025710, 542142955];
export const isAdmin = (userId?: number): boolean => {
  if (!userId) return false;
  return ADMIN_USER_IDS.includes(userId);
};
