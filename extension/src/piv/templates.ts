// PIV predefined entry templates — empty shells the user fills once.
//
// Templates carry NO values, only labels + alias hints. Safe to bundle and
// safe to render: there is nothing sensitive here until the user types.

import type { PIVCategory } from './store';

export interface PIVTemplate {
  label: string;
  aliasHint: string;
}

export interface PIVTemplateGroup {
  category: PIVCategory;
  title: string;
  icon: string;
  templates: PIVTemplate[];
}

export const PIV_TEMPLATE_GROUPS: PIVTemplateGroup[] = [
  {
    category: 'personal',
    title: 'Personal',
    icon: '👤',
    templates: [
      { label: 'Full Name', aliasHint: 'USER_NAME_1' },
      { label: 'First Name', aliasHint: 'USER_FIRSTNAME_1' },
      { label: 'Last Name', aliasHint: 'USER_LASTNAME_1' },
      { label: 'Date of Birth', aliasHint: 'USER_DOB_1' },
      { label: 'Gender', aliasHint: 'USER_GENDER_1' },
      { label: 'Nationality', aliasHint: 'USER_NATIONALITY_1' },
    ],
  },
  {
    category: 'contact',
    title: 'Contact',
    icon: '📞',
    templates: [
      { label: 'Personal Email', aliasHint: 'USER_EMAIL_1' },
      { label: 'Work Email', aliasHint: 'USER_EMAIL_2' },
      { label: 'Mobile Number', aliasHint: 'USER_PHONE_1' },
      { label: 'Alternate Phone', aliasHint: 'USER_PHONE_2' },
      { label: 'Home Address', aliasHint: 'USER_ADDRESS_1' },
      { label: 'City', aliasHint: 'USER_CITY_1' },
      { label: 'State', aliasHint: 'USER_STATE_1' },
      { label: 'PIN Code', aliasHint: 'USER_PINCODE_1' },
      { label: 'Country', aliasHint: 'USER_COUNTRY_1' },
    ],
  },
  {
    category: 'identity',
    title: 'Identity',
    icon: '🪪',
    templates: [
      { label: 'Aadhaar Number', aliasHint: 'USER_AADHAAR_1' },
      { label: 'PAN Card', aliasHint: 'USER_PAN_1' },
      { label: 'Passport Number', aliasHint: 'USER_PASSPORT_1' },
      { label: 'Voter ID', aliasHint: 'USER_VOTER_1' },
      { label: 'Driving License', aliasHint: 'USER_LICENSE_1' },
    ],
  },
  {
    category: 'financial',
    title: 'Financial',
    icon: '💳',
    templates: [
      { label: 'UPI ID', aliasHint: 'USER_UPI_1' },
      { label: 'Bank Account', aliasHint: 'USER_ACCOUNT_1' },
      { label: 'IFSC Code', aliasHint: 'USER_IFSC_1' },
      { label: 'Card Number', aliasHint: 'USER_CARD_1' },
      { label: 'Card Expiry', aliasHint: 'USER_EXPIRY_1' },
    ],
  },
  {
    category: 'professional',
    title: 'Professional',
    icon: '💼',
    templates: [
      { label: 'Organization', aliasHint: 'USER_ORG_1' },
      { label: 'Designation', aliasHint: 'USER_ROLE_1' },
      { label: 'Employee ID', aliasHint: 'USER_EMPID_1' },
      { label: 'Work Address', aliasHint: 'USER_WORKADDR_1' },
    ],
  },
  {
    category: 'custom',
    title: 'Custom',
    icon: '⚙️',
    templates: [],
  },
];

export function templatesForCategory(category: PIVCategory): PIVTemplate[] {
  return PIV_TEMPLATE_GROUPS.find((g) => g.category === category)?.templates ?? [];
}
