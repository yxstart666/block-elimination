/** Enable only after deploying the leaderboard cloud function to your own AppID. */
export type LeaderboardConfig = {
  enabled: boolean;
  environmentId: string;
  functionName: string;
  friendsOpenData: boolean;
};

export const LEADERBOARD_CONFIG: LeaderboardConfig = {
  enabled: false,
  environmentId: '',
  functionName: 'leaderboard',
  friendsOpenData: false,
};
