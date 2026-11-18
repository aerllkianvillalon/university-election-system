// How a contest's certified counts are labelled. Pure on purpose: it is unit-tested (tests/results-rank.test.ts) because a wrong label is a wrong statement about an election.
// It never says who WON. The winner rule and the tie-break are the election committee's decision, not this code's.
export type Counted = { id: string; name: string; votes: number };
export type Standing = 'Highest votes' | 'Tied' | '';
export type ContestRank = { rows: (Counted & { standing: Standing })[]; tie: boolean; short: boolean };

// `list` must be sorted by votes, highest first (the server does this).
export function rankContest(list: Counted[], seats: number): ContestRank {
  const cutoff = list[seats - 1]?.votes;
  // a tie only matters where votes were cast: two candidates on zero for a seat is "nobody got votes", not a tie
  const tie = list.length > seats && cutoff !== undefined && cutoff > 0 && list[seats]?.votes === cutoff;
  const short = list.filter((c) => c.votes > 0).length < seats;   // fewer candidates with votes than seats
  return { tie, short, rows: list.map((c, i) => ({ ...c, standing: tie && c.votes === cutoff ? 'Tied' : i < seats && c.votes > 0 ? 'Highest votes' : '' })) };
}
