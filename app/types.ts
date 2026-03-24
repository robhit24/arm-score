export type Result = {
  score: number;
  score_label: string;
  breakdown: { timing: number; power_transfer: number; bat_control: number };
  top3: string[];
  impact_line: string;
  uplift_line: string;
};
