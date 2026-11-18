import type { AdminOverview, Booth, CertifiedResult, Election, Organization } from './types';
import ayaPortrait from '../../assets/images/candidate-aya.webp';
import julioPortrait from '../../assets/images/candidate-julio.webp';
import mikaPortrait from '../../assets/images/candidate-mika.webp';
import renzoPortrait from '../../assets/images/candidate-renzo.webp';

export const organizations: Organization[] = [
  { id: 'student-council', name: 'Student Council', short: 'SC', accent: 'Campus-wide', electionId: 'election-current' },
  { id: 'engineering-society', name: 'Engineering Society', short: 'ES', accent: 'College of Engineering', electionId: 'engineering-election' },
  { id: 'campus-arts', name: 'Campus Creatives Guild', short: 'CCG', accent: 'Arts & Culture', electionId: 'guild-election' },
];

const candidates = [
  { id: 'aya-santos', name: 'Aya Santos', program: 'BS Information Technology', tag: 'FORWARD · President', photo: ayaPortrait, statement: 'A student-first campus: practical support, open communication, and a culture where every voice is heard.' },
  { id: 'julio-reyes', name: 'Julio Reyes', program: 'BS Civil Engineering', tag: 'FORWARD · Vice President', photo: julioPortrait, statement: 'Make campus life easier to navigate—with clear services, strong peer support, and better coordination.' },
  { id: 'mika-dizon', name: 'Mika Dizon', program: 'BS Computer Science', tag: 'KINETIC · Senator', photo: mikaPortrait, statement: 'Turn good ideas into inclusive events and a campus community that feels connected.' },
  { id: 'renzo-lim', name: 'Renzo Lim', program: 'BS Electronics Engineering', tag: 'KINETIC · Senator', photo: renzoPortrait, statement: 'Build a transparent council and make student representation useful in everyday campus life.' },
];

const engineeringCandidates = [
  { ...candidates[2], id: 'mika-dizon-engineering', tag: 'ENGINEERING SOCIETY · PRESIDENT', statement: 'Open lab hours, clearer project support, and stronger connections between engineering cohorts.' },
  { ...candidates[3], id: 'renzo-lim-engineering', tag: 'ENGINEERING SOCIETY · PRESIDENT', statement: 'Practical peer mentoring and transparent access to tools for every engineering student.' },
];
const creativeCandidates = [
  { ...candidates[0], id: 'aya-santos-creatives', tag: 'CAMPUS CREATIVES · REPRESENTATIVE', statement: 'More room to make: accessible workshops, shared materials, and a campus gallery for student work.' },
  { ...candidates[1], id: 'julio-reyes-creatives', tag: 'CAMPUS CREATIVES · REPRESENTATIVE', statement: 'A stronger creative community through inclusive events, campus showcases, and hands-on collaboration.' },
];

export const elections: Election[] = [
  {
    id: 'election-current', organizationId: 'student-council', title: 'Student Council Elections 2026', status: 'Open', phase: 'Open',
    opensAt: 'October 6, 2026 · 8:00 AM', closesAt: 'October 8, 2026 · 5:00 PM', turnout: 628, totalEligible: 1240,
    contests: [
      { id: 'president', title: 'President', seats: 1, description: 'Choose one candidate to serve as student council president.', candidates: [candidates[0]] },
      { id: 'vice-president', title: 'Vice President', seats: 1, description: 'Choose one candidate to serve as vice president.', candidates: [candidates[1]] },
      { id: 'senators', title: 'Student Senators', seats: 2, description: 'Select up to two candidates to represent your student community.', candidates: candidates.slice(2) },
    ],
  },
  {
    id: 'engineering-election', organizationId: 'engineering-society', title: 'Engineering Society Officers', status: 'Open', phase: 'Open',
    opensAt: 'October 6, 2026 · 8:00 AM', closesAt: 'October 8, 2026 · 5:00 PM', turnout: 212, totalEligible: 448,
    contests: [{ id: 'engineering-president', title: 'Society President', seats: 1, description: 'Choose one candidate to represent Engineering Society students.', candidates: engineeringCandidates }],
  },
  {
    id: 'guild-election', organizationId: 'campus-arts', title: 'Creatives Guild Council', status: 'Upcoming', phase: 'Setup',
    opensAt: 'October 12, 2026 · 9:00 AM', closesAt: 'October 14, 2026 · 4:00 PM', turnout: 0, totalEligible: 96,
    contests: [{ id: 'guild-representatives', title: 'Guild Representatives', seats: 2, description: 'Select up to two representatives for the Campus Creatives Guild.', candidates: creativeCandidates }],
  },
];

export const certifiedElection: Election = {
  id: 'archive-2025', organizationId: 'student-council', title: 'Student Council Elections 2025', status: 'Certified', phase: 'Certified', opensAt: 'October 2, 2025 · 8:00 AM', closesAt: 'October 4, 2025 · 5:00 PM', turnout: 1088, totalEligible: 1320, contests: [],
};

export const certifiedResults: CertifiedResult[] = [
  { contestId: 'president', title: 'President', winners: ['Lia Navarro'], certifiedAt: 'October 7, 2025 · 3:20 PM' },
  { contestId: 'vice-president', title: 'Vice President', winners: ['Jared Montalban'], certifiedAt: 'October 7, 2025 · 3:20 PM' },
  { contestId: 'senators', title: 'Student Senators', winners: ['Emi Garcia', 'Noah Tan'], certifiedAt: 'October 7, 2025 · 3:20 PM' },
];

const readiness = ['Election dates set', 'Candidate slate reviewed', 'Voter roll validated', 'Lab booths assigned'];
const aggregateRows: Record<string, Pick<AdminOverview, 'checkedIn' | 'webBallots' | 'labBallots' | 'boothCount' | 'attentionCount' | 'pendingApprovals'>> = {
  'student-council': { checkedIn: 36, webBallots: 592, labBallots: 36, boothCount: 4, attentionCount: 1, pendingApprovals: 1 },
  'engineering-society': { checkedIn: 14, webBallots: 198, labBallots: 14, boothCount: 2, attentionCount: 0, pendingApprovals: 0 },
  'campus-arts': { checkedIn: 0, webBallots: 0, labBallots: 0, boothCount: 1, attentionCount: 0, pendingApprovals: 0 },
};
export const adminOverviews: Record<string, AdminOverview> = Object.fromEntries(organizations.map((organization) => {
  const election = elections.find((entry) => entry.id === organization.electionId)!;
  const aggregate = aggregateRows[organization.id];
  const candidateCount = election.contests.reduce((total, contest) => total + contest.candidates.length, 0);
  return [organization.id, {
    organizationId: organization.id, electionTitle: election.title, phase: election.phase,
    turnout: election.turnout, eligible: election.totalEligible, ...aggregate,
    candidateCount, contestCount: election.contests.length, readiness,
    organizations: organizations.map((entry) => entry.name),
  } satisfies AdminOverview];
}));

export const mockAuthUsers = [
  { identifier: 'demo-student', email: 'demo-student@danao.ctu.edu.ph', password: 'demopassword', displayName: 'Student voter' },
];
export const mockRegistration = { studentId: '2026-00001', voucher: 'DANAO-2026-DEMO' };

export const booths: Booth[] = [
  { id: 'booth-01', number: '01', state: 'In use', voter: 'ID ending ··42', elapsed: '04:18' },
  { id: 'booth-02', number: '02', state: 'Available', voter: '—', elapsed: '—' },
  { id: 'booth-03', number: '03', state: 'Needs attention', voter: '—', elapsed: '—' },
  { id: 'booth-04', number: '04', state: 'Available', voter: '—', elapsed: '—' },
];
export const boothsByOrganization: Record<string, Booth[]> = {
  'student-council': booths,
  'engineering-society': [
    { id: 'engineering-booth-01', number: '01', state: 'In use', voter: 'ID ending ··19', elapsed: '02:10' },
    { id: 'engineering-booth-02', number: '02', state: 'Available', voter: '—', elapsed: '—' },
  ],
  'campus-arts': [
    { id: 'creatives-booth-01', number: '01', state: 'Available', voter: '—', elapsed: '—' },
  ],
};
