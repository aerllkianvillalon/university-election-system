export type Lifecycle = 'Draft' | 'Setup' | 'Open' | 'Paused' | 'Frozen' | 'Closed' | 'Certified';
export type ElectionStatus = 'Open' | 'Upcoming' | 'Paused' | 'Closed' | 'Certified';
export type Candidate = { id: string; name: string; program: string; tag: string; photo: string; statement: string; photoAlt?: string };
export type Contest = { id: string; title: string; seats: number; candidates: Candidate[]; description: string; allowAbstain?: boolean };
export type Organization = { id: string; name: string; short: string; accent: string; electionId: string };
export type Election = { id: string; organizationId: string; title: string; status: ElectionStatus; phase: Lifecycle; opensAt: string; closesAt: string; turnout: number; totalEligible: number; contests: Contest[]; signedIn?: boolean };
export type OrganizationElection = { organization: Organization; election: Election };
export type SelectionMap = Record<string, string[]>;
export type BallotDraft = { electionId: string; selections: SelectionMap; expiresAt: number };
export type Receipt = { id: string; hash: string; recordedAt: string; state: 'recorded' | 'sealed' };
export type ResultCandidate = { id: string; name: string; votes: number };
// Mock data carries `winners`. Live data carries certified counts instead: who is elected, and how ties are decided, is not decided by this code.
export type CertifiedResult = { contestId: string; title: string; winners: string[]; certifiedAt: string; seats?: number; abstain?: number; candidates?: ResultCandidate[] };
export type ResultsProof = { ballots: number; signingKey: string; signingKeyFingerprint: string; sets: { chain: string; chainTip: string; body: string; signature: string }[] };
export type AdminOverview = { organizationId: string; electionTitle: string; phase: Lifecycle; turnout: number; eligible: number; checkedIn: number; webBallots: number; labBallots: number; boothCount: number; attentionCount: number; candidateCount: number; contestCount: number; readiness: string[]; pendingApprovals: number; organizations: string[] };
export type Booth = { id: string; number: string; state: 'Available' | 'In use' | 'Needs attention'; voter: string; elapsed: string };
export type AuthRequest = { identifier: string; password: string };
export type RegisterRequest = { studentId: string; voucher: string; password: string; termsAccepted: boolean };
export type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string };
export type GenericFailure = { ok: false; message: string };
export const GENERIC_FAILURE_MESSAGE = 'We couldn’t complete that request. Check your details and try again.';

export type SupportKind = 'claim' | 'protest' | 'dispute' | 'report';
