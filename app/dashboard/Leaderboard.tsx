"use client";

import { useEffect, useState } from "react";
import s from "./leaderboard.module.css";

type Entry = {
  rank: number;
  display_name: string;
  score: number;
  percentile: number;
  age_group: string;
  sport: string;
  is_you: boolean;
};

export function Leaderboard() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [myRank, setMyRank] = useState<number | null>(null);
  const [myPercentile, setMyPercentile] = useState<number | null>(null);
  const [filterAge, setFilterAge] = useState("");
  const [filterSport, setFilterSport] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filterAge) params.set("age_group", filterAge);
    if (filterSport) params.set("sport", filterSport);

    fetch(`/api/leaderboard?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setEntries(data.leaderboard || []);
        setTotal(data.total_athletes || 0);
        setMyRank(data.my_rank);
        setMyPercentile(data.my_percentile);
      })
      .finally(() => setLoading(false));
  }, [filterAge, filterSport]);

  return (
    <div className={s.wrap}>
      <div className={s.header}>
        <div className={s.title}>Leaderboard</div>
        <div className={s.totalBadge}>{total} athletes</div>
      </div>

      {/* Your position */}
      {myRank && (
        <div className={s.myRank}>
          <div className={s.myRankLeft}>
            <span className={s.myRankLabel}>Your Rank</span>
            <span className={s.myRankNum}>#{myRank}</span>
          </div>
          <div className={s.myRankRight}>
            <span className={s.myPercentile}>
              Top {100 - (myPercentile || 0)}%
            </span>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className={s.filters}>
        <select
          value={filterAge}
          onChange={(e) => setFilterAge(e.target.value)}
          className={s.filterSelect}
        >
          <option value="">All ages</option>
          {["8U","9U","10U","11U","12U","13U","14U","15U","16U","17U","18U","College/Adult"].map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select
          value={filterSport}
          onChange={(e) => setFilterSport(e.target.value)}
          className={s.filterSelect}
        >
          <option value="">All sports</option>
          <option value="baseball">Baseball</option>
          <option value="softball">Softball</option>
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <div className={s.loading}>Loading...</div>
      ) : entries.length === 0 ? (
        <div className={s.empty}>No scores yet for this filter.</div>
      ) : (
        <div className={s.table}>
          {entries.map((e) => (
            <div
              key={e.rank}
              className={s.row}
              data-you={e.is_you}
              data-top3={e.rank <= 3}
            >
              <div className={s.rankCol}>
                {e.rank <= 3 ? (
                  <span className={s.medal} data-rank={e.rank}>
                    {e.rank === 1 ? "🥇" : e.rank === 2 ? "🥈" : "🥉"}
                  </span>
                ) : (
                  <span className={s.rankNum}>{e.rank}</span>
                )}
              </div>
              <div className={s.nameCol}>
                <div className={s.name}>
                  {e.display_name}
                  {e.is_you && <span className={s.youBadge}>You</span>}
                </div>
                <div className={s.meta}>{e.age_group} · {e.sport}</div>
              </div>
              <div className={s.scoreCol}>
                <div className={s.score} data-level={
                  e.score >= 85 ? "green" : e.score >= 70 ? "amber" : "red"
                }>
                  {e.score}
                </div>
                <div className={s.pct}>Top {100 - e.percentile}%</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
