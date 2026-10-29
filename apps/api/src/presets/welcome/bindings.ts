import {
  formatPaiseToRupees,
} from '../../templates';

export { formatPaiseToRupees };

export const WELCOME_ALLOWED_BINDING_SOURCES = [
  'customer.firstName',
  'shop.displayName',
  'offer.amountRupees',
  'order.firstOrderDate',
  'order.firstOrderNumber',
  'literal',
] as const;

export type WelcomeAllowedBindingSource = (typeof WELCOME_ALLOWED_BINDING_SOURCES)[number];
