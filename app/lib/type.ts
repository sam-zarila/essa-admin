// Centralized types for the admin dashboard + API

export type LoanStatus = 'OUTSTANDING' | 'OVERDUE' | 'FINISHED';

export interface AdminTotals {
  outstandingCount: number;
  outstandingBalanceSum: number;
  collateralCount: number;
}

export interface LoanRow {
  id: string;
  borrowerName: string;
  principal: number;
  currentBalance: number;
  dueDate: string; // ISO date
  status: LoanStatus;
  collateralCount: number;
}

export interface AdminOverviewData {
  totals: AdminTotals;
  outstandingTop: LoanRow[];
  deadlinesUpcoming: LoanRow[];
  overdueWithCollateral: LoanRow[];
  finished: LoanRow[];
}

// Common API envelope if you use one
export interface ApiError {
  error: string;
}
