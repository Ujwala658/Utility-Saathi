export const COMPLAINT_CATEGORIES = ['billing', 'meter', 'payment', 'power', 'water', 'other'] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

export const COMPLAINT_STATUSES = ['submitted', 'acknowledged', 'under_review', 'escalated', 'resolved', 'closed'] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

export const COMPLAINT_TRANSITIONS: Record<ComplaintStatus, ComplaintStatus[]> = {
  submitted: ['acknowledged'],
  acknowledged: ['under_review', 'escalated'],
  under_review: ['escalated', 'resolved'],
  escalated: ['under_review', 'resolved'],
  resolved: ['closed', 'under_review'],
  closed: [],
};

/** Days after which an unresolved complaint is shown as overdue to administrators. */
export const COMPLAINT_SLA_DAYS = 7;
