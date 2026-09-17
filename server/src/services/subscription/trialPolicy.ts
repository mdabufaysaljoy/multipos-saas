/**
 * The free trial is a business rule, not configuration: every trial lasts
 * exactly this long, however it is granted (signup, a new workspace, or a
 * platform admin). A plan's `trialDays > 0` only marks it as the plan a trial
 * runs on; the length always comes from here.
 */
export const TRIAL_LENGTH_DAYS = 7;
