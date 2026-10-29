import { DateTime } from 'luxon';
import { config } from '../config/env';
import { clock } from '../services/clock';
import { encryptPhone, destinationHash, maskPhone } from '../utils/crypto';
import { OCCASION_KIND, OCCASION_STATUS, OCCASION_CATEGORIES } from '@grovastra/shared';

export interface CustomerSeedRecord {
  customerId: string;
  firstName: string;
  rawPhone: string;
  birthday: { month: number; day: number } | null;
  marketingOptIn: boolean;
  channelSuppressed: boolean;
  preferences: {
    weave?: string;
    budgetMaxPaise?: number;
    size?: string;
    colour?: string;
  };
  tags: string[];
  status: string;
  branchId: string;
  deletedAt?: Date | null;
  language: string;
  isLive: boolean;
  events?: Array<{
    eventId: string;
    type: string;
    kind?: string;
    eventDate?: { year: number; month: number; day: number };
    eventDateKey?: string;
    month: number;
    day: number;
    label?: string;
    recipientLabel?: string | null;
    budgetPaise?: number | null;
    categories?: string[];
    status?: string;
    declaredByCustomer?: boolean;
    declaredAt?: Date | null;
    source?: string;
  }>;
  orders?: Array<{
    orderId: string;
    status: string;
    paid: boolean;
    netPaise: number;
    grossPaise?: number;
    refundedPaise?: number;
    occasionRef?: string | null;
    completedAt?: Date | null;
    branchId?: string;
    lines: Array<{
      lineId: string;
      itemRef: string;
      name: string;
      quantity: number;
      pricePaise: number;
    }>;
  }>;
}

export function generateSeedData(
  scenario: string = 'base',
  options: { live?: boolean } = {}
): {
  shopACustomers: CustomerSeedRecord[];
  shopBCustomers: CustomerSeedRecord[];
} {
  const currentEngineTime = clock.now();
  const todayMonth = currentEngineTime.getUTCMonth() + 1; // 1-12
  const todayDay = currentEngineTime.getUTCDate(); // 1-31

  // 1. Process LIVE customers from LIVE_CUSTOMER_PHONES (or fallback to META_TEST_ALLOWLIST)
  let rawPhonesStr = (config.LIVE_CUSTOMER_PHONES || '').trim();
  if (!rawPhonesStr || rawPhonesStr.startsWith('<')) {
    rawPhonesStr = (config.META_TEST_ALLOWLIST || '').trim();
  }

  const rawLivePhones = rawPhonesStr
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.replace(/\D/g, '').length >= 8);

  const liveCustomers: CustomerSeedRecord[] = [];
  rawLivePhones.slice(0, 5).forEach((phone, idx) => {
    liveCustomers.push({
      customerId: `cus_live_0${idx + 1}`,
      firstName: idx === 0 ? 'Verified Owner (Live)' : `Live Customer ${idx + 1}`,
      rawPhone: phone,
      birthday: { month: todayMonth, day: todayDay }, // Ready for immediate birthday trigger testing!
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: {
        weave: 'Kanjivaram Silk',
        budgetMaxPaise: 4500000, // Rs 45,000
        size: 'L',
        colour: 'Royal Purple & Gold Zari',
      },
      tags: ['live_test', 'verified', 'allowlist', 'vip'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: true,
      events: [],
      orders: [],
    });
  });

  // 2. Curated core edge cases (Hard Rules & Scenario Fixtures)
  const coreShopACustomers: CustomerSeedRecord[] = [
    // Jan 5 Birthday
    {
      customerId: 'cus_bday_jan05',
      firstName: 'Priya Sharma',
      rawPhone: '+91 91000 00001',
      birthday: { month: 1, day: 5 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Chanderi', budgetMaxPaise: 1500000, size: 'M', colour: 'Pastel Mint' },
      tags: ['demo', 'mock', 'jan_birthday', 'regular'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_001',
          status: 'COMPLETED',
          paid: true,
          netPaise: 480000, // Rs 4,800
          completedAt: new Date('2026-10-01T11:00:00Z'),
          branchId: 'branch_main',
          lines: [
            {
              lineId: 'line_001_1',
              itemRef: 'item_kanjivaram_silk',
              name: 'Kanjivaram Silk Saree',
              quantity: 1,
              pricePaise: 480000,
            },
          ],
        },
      ],
    },

    // Synthetic Customer: Lakshmi (Spec p33 Worked Example)
    {
      customerId: 'cus_lakshmi',
      firstName: 'Lakshmi',
      rawPhone: '+91 91000 00099',
      birthday: { month: 1, day: 5 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'silk', budgetMaxPaise: 600000, size: 'M', colour: 'Royal Gold' },
      tags: ['demo', 'mock', 'jan_birthday', 'vip', 'occasionwear'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_lakshmi_001',
          status: 'COMPLETED',
          paid: true,
          netPaise: 580000, // Rs 5,800
          occasionRef: 'birthday:2027',
          completedAt: new Date('2026-12-24T12:00:00Z'),
          branchId: 'branch_main',
          lines: [
            {
              lineId: 'line_lakshmi_01',
              itemRef: 'item_pure_silk_saree',
              name: 'Pure Silk Saree',
              quantity: 1,
              pricePaise: 580000,
            },
          ],
        },
      ],
    },

    // Feb 29 Birthday (Leap Year Edge Case)
    {
      customerId: 'cus_bday_feb29',
      firstName: 'Ananya Sen',
      rawPhone: '+91 91000 00002',
      birthday: { month: 2, day: 29 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Banarasi', budgetMaxPaise: 6000000, size: 'S', colour: 'Ruby Crimson' },
      tags: ['demo', 'mock', 'leap_year_birthday', 'vip'],
      status: 'ACTIVE',
      branchId: 'branch_two',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_005',
          status: 'COMPLETED',
          paid: true,
          netPaise: 580000, // Spec page 24 exact match
          occasionRef: 'birthday:2027',
          completedAt: new Date('2026-10-10T16:00:00Z'),
          branchId: 'branch_two',
          lines: [
            {
              lineId: 'line_005_1',
              itemRef: 'item_raw_silk_saree',
              name: 'Hand-woven Raw Silk Saree',
              quantity: 1,
              pricePaise: 580000,
            },
          ],
        },
      ],
    },

    // Dec 31 Birthday (Year Boundary Edge Case)
    {
      customerId: 'cus_bday_dec31',
      firstName: 'Sunita Reddy',
      rawPhone: '+91 91000 00003',
      birthday: { month: 12, day: 31 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Pochampally', budgetMaxPaise: 2800000, size: 'XL', colour: 'Indigo Blue' },
      tags: ['demo', 'mock', 'year_end_birthday'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'te',
      isLive: false,
      orders: [
        {
          orderId: 'ord_004',
          status: 'PARTIALLY_REFUNDED',
          paid: true,
          netPaise: 190000, // Rs 1,900
          completedAt: new Date('2026-09-20T14:30:00Z'),
          branchId: 'branch_main',
          lines: [
            {
              lineId: 'line_004_1',
              itemRef: 'item_tussar_silk_kurta',
              name: 'Tussar Silk Kurta & Stole',
              quantity: 1,
              pricePaise: 380000,
            },
          ],
        },
      ],
    },

    // Opted Out Customer
    {
      customerId: 'cus_opted_out',
      firstName: 'Meera Iyer',
      rawPhone: '+91 91000 00004',
      birthday: { month: 6, day: 14 },
      marketingOptIn: false,
      channelSuppressed: false,
      preferences: { weave: 'Tussar', budgetMaxPaise: 2000000, size: 'M', colour: 'Natural Beige' },
      tags: ['demo', 'mock', 'opted_out'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'ta',
      isLive: false,
      orders: [
        {
          orderId: 'ord_003',
          status: 'CANCELLED',
          paid: false,
          netPaise: 350000,
          completedAt: null,
          branchId: 'branch_main',
          lines: [
            {
              lineId: 'line_003_1',
              itemRef: 'item_banarasi_brocade',
              name: 'Banarasi Brocade Unstitched Suit',
              quantity: 1,
              pricePaise: 350000,
            },
          ],
        },
      ],
    },

    // Channel Suppressed Customer
    {
      customerId: 'cus_channel_suppressed',
      firstName: 'Divya Nair',
      rawPhone: '+91 91000 00005',
      birthday: { month: 8, day: 22 },
      marketingOptIn: true,
      channelSuppressed: true,
      preferences: { weave: 'Kasavu', budgetMaxPaise: 3000000, size: 'L', colour: 'Off-White & Gold' },
      tags: ['demo', 'mock', 'suppressed'],
      status: 'ACTIVE',
      branchId: 'branch_two',
      language: 'en',
      isLive: false,
    },

    // Both Opted Out & Channel Suppressed
    {
      customerId: 'cus_blocked_all',
      firstName: 'Rekha Joshi',
      rawPhone: '+91 91000 00006',
      birthday: { month: 3, day: 11 },
      marketingOptIn: false,
      channelSuppressed: true,
      preferences: { weave: 'Paithani', budgetMaxPaise: 5000000, size: 'M', colour: 'Emerald Green' },
      tags: ['demo', 'mock', 'blocked'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'mr',
      isLive: false,
    },

    // Deleted Customer (Tombstone test)
    {
      customerId: 'cus_deleted',
      firstName: 'Geeta Pillai',
      rawPhone: '+91 91000 00007',
      birthday: { month: 5, day: 19 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Kalamkari', budgetMaxPaise: 1800000, size: 'S', colour: 'Terracotta' },
      tags: ['demo', 'mock', 'deleted'],
      status: 'DELETED',
      branchId: 'branch_main',
      deletedAt: new Date('2026-08-15T10:00:00Z'),
      language: 'en',
      isLive: false,
    },

    // No Birthday Customer
    {
      customerId: 'cus_no_birthday',
      firstName: 'Pooja Bhatt',
      rawPhone: '+91 91000 00008',
      birthday: null,
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Ikat', budgetMaxPaise: 2500000, size: 'M', colour: 'Mustard Yellow' },
      tags: ['demo', 'mock', 'no_dob'],
      status: 'ACTIVE',
      branchId: 'branch_two',
      language: 'hi',
      isLive: false,
    },

    // Two Records Sharing One Phone (Household Duplicate Collision)
    {
      customerId: 'cus_household_1',
      firstName: 'Aarav Gupta',
      rawPhone: '+91 91000 00088', // Same phone as cus_household_2
      birthday: { month: 4, day: 10 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Linen', budgetMaxPaise: 2200000, size: 'XL', colour: 'Steel Grey' },
      tags: ['demo', 'mock', 'household_shared'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'hi',
      isLive: false,
    },
    {
      customerId: 'cus_household_2',
      firstName: 'Siddharth Gupta',
      rawPhone: '+91 91000 00088', // Same phone as cus_household_1
      birthday: { month: 9, day: 25 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Mulmul', budgetMaxPaise: 1800000, size: 'L', colour: 'Pure White' },
      tags: ['demo', 'mock', 'household_shared'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'hi',
      isLive: false,
    },

    // Two with an Anniversary
    {
      customerId: 'cus_anniv_1',
      firstName: 'Ritu Deshmukh',
      rawPhone: '+91 91000 00011',
      birthday: { month: 9, day: 18 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Paithani', budgetMaxPaise: 4800000, size: 'M', colour: 'Peacock Blue' },
      tags: ['demo', 'mock', 'anniversary_target'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'mr',
      isLive: false,
      events: [
        {
          eventId: 'evt_anniv_001',
          type: 'anniversary',
          month: 11,
          day: 15,
          label: 'Silver Wedding Anniversary',
        },
      ],
      orders: [
        {
          orderId: 'ord_002',
          status: 'PENDING',
          paid: false,
          netPaise: 250000, // Rs 2,500
          completedAt: null,
          branchId: 'branch_main',
          lines: [
            {
              lineId: 'line_002_1',
              itemRef: 'item_chanderi_dupatta',
              name: 'Handloom Chanderi Dupatta',
              quantity: 1,
              pricePaise: 250000,
            },
          ],
        },
      ],
    },
    {
      customerId: 'cus_anniv_2',
      firstName: 'Neha Kapoor',
      rawPhone: '+91 91000 00012',
      birthday: { month: 7, day: 8 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Bandhani', budgetMaxPaise: 3200000, size: 'S', colour: 'Sindoor Red' },
      tags: ['demo', 'mock', 'anniversary_target'],
      status: 'ACTIVE',
      branchId: 'branch_two',
      language: 'hi',
      isLive: false,
      events: [
        {
          eventId: 'evt_anniv_002',
          type: 'anniversary',
          month: 4,
          day: 20,
          label: 'Marriage Anniversary',
        },
      ],
    },

    // One with Multiple Saved Anniversaries
    {
      customerId: 'cus_multi_anniv',
      firstName: 'Shalini Verma',
      rawPhone: '+91 91000 00013',
      birthday: { month: 10, day: 12 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Kanjivaram', budgetMaxPaise: 7500000, size: 'M', colour: 'Burgundy' },
      tags: ['demo', 'mock', 'multi_anniversary', 'vip'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      events: [
        {
          eventId: 'evt_anniv_multi_01',
          type: 'anniversary',
          month: 2,
          day: 14,
          label: 'Wedding Anniversary',
        },
        {
          eventId: 'evt_anniv_multi_02',
          type: 'anniversary',
          month: 8,
          day: 10,
          label: 'Heritage Patron Inception',
        },
      ],
    },
  ];

  // 3. Additional diverse boutique customers to bring shop_a total to ~40
  const additionalNames = [
    { name: 'Kavita Menon', weave: 'Kasavu', colour: 'Gold Cream', phone: '+91 91000 00014', bday: { month: 1, day: 22 } },
    { name: 'Radhika Sen', weave: 'Jamdani', colour: 'Pale Aqua', phone: '+91 91000 00015', bday: { month: 2, day: 10 } },
    { name: 'Ayesha Khan', weave: 'Chanderi', colour: 'Dusty Rose', phone: '+91 91000 00016', bday: { month: 3, day: 15 } },
    { name: 'Swati Agarwal', weave: 'Banarasi', colour: 'Maroon', phone: '+91 91000 00017', bday: { month: 3, day: 28 } },
    { name: 'Padmini Narayanan', weave: 'Kanjivaram', colour: 'Temple Mustard', phone: '+91 91000 00018', bday: { month: 4, day: 4 } },
    { name: 'Bhavna Kulkarni', weave: 'Paithani', colour: 'Magenta', phone: '+91 91000 00019', bday: { month: 5, day: 9 } },
    { name: 'Tanvi Trivedi', weave: 'Patan Patola', colour: 'Crimson Ikat', phone: '+91 91000 00020', bday: { month: 5, day: 25 } },
    { name: 'Smita Patil', weave: 'Maheshwari', colour: 'Charcoal Teal', phone: '+91 91000 00021', bday: { month: 6, day: 3 } },
    { name: 'Deepika Roy', weave: 'Baluchari', colour: 'Deep Plum', phone: '+91 91000 00022', bday: { month: 6, day: 21 } },
    { name: 'Ankita Rao', weave: 'Gadwal', colour: 'Sage Green', phone: '+91 91000 00023', bday: { month: 7, day: 14 } },
    { name: 'Gayatri Sundaram', weave: 'Chettinad Cotton', colour: 'Ochre & Black', phone: '+91 91000 00024', bday: { month: 7, day: 30 } },
    { name: 'Nandini Das', weave: 'Sambalpuri', colour: 'Rust Orange', phone: '+91 91000 00025', bday: { month: 8, day: 7 } },
    { name: 'Madhuri Joshi', weave: 'Kota Doria', colour: 'Powder Blue', phone: '+91 91000 00026', bday: { month: 8, day: 18 } },
    { name: 'Preeti Saxena', weave: 'Chikan Embroidered', colour: 'Pristine White', phone: '+91 91000 00027', bday: { month: 9, day: 2 } },
    { name: 'Manju Bansal', weave: 'Banarasi Georgette', colour: 'Coral Peach', phone: '+91 91000 00028', bday: { month: 9, day: 14 } },
    { name: 'Ipsita Bose', weave: 'Tussar Ghicha', colour: 'Earth Tan', phone: '+91 91000 00029', bday: { month: 10, day: 5 } },
    { name: 'Urmila Hegde', weave: 'Mysore Silk', colour: 'Coffee Brown', phone: '+91 91000 00030', bday: { month: 10, day: 27 } },
    { name: 'Sheetal Jain', weave: 'Leheriya Silk', colour: 'Bright Fuchsia', phone: '+91 91000 00031', bday: { month: 11, day: 3 } },
    { name: 'Leela Krishnan', weave: 'Pochampally', colour: 'Teal & Ruby', phone: '+91 91000 00032', bday: { month: 11, day: 21 } },
    { name: 'Alka Mehta', weave: 'Kanjeevaram Brocade', colour: 'Emerald & Copper', phone: '+91 91000 00033', bday: { month: 12, day: 12 } },
    { name: 'Tara Sethi', weave: 'Handloom Tussar', colour: 'Warm Ochre', phone: '+91 91000 00034', bday: { month: 12, day: 19 } },
    { name: 'Devika Mukherjee', weave: 'Kantha Stitch', colour: 'Indigo Navy', phone: '+91 91000 00035', bday: { month: 1, day: 17 } },
    { name: 'Harini Balan', weave: 'Venkatagiri Silk', colour: 'Olive Gold', phone: '+91 91000 00036', bday: { month: 2, day: 5 } },
    { name: 'Rupal Shah', weave: 'Bandhani Georgette', colour: 'Turquoise', phone: '+91 91000 00037', bday: { month: 3, day: 8 } },
    { name: 'Shruti Varma', weave: 'Muga Silk', colour: 'Rich Golden', phone: '+91 91000 00038', bday: { month: 4, day: 16 } },
    { name: 'Bishakha Sen', weave: 'Dhakai Jamdani', colour: 'Soft Lilac', phone: '+91 91000 00039', bday: { month: 5, day: 12 } },
    { name: 'Yamini Reddy', weave: 'Uppada Silk', colour: 'Coral Rose', phone: '+91 91000 00040', bday: { month: 11, day: 9 } },
  ];

  const generatedShopACustomers: CustomerSeedRecord[] = additionalNames.map((item, idx) => ({
    customerId: `cus_gen_${String(idx + 1).padStart(2, '0')}`,
    firstName: item.name,
    rawPhone: item.phone,
    birthday: item.bday,
    marketingOptIn: true,
    channelSuppressed: false,
    preferences: {
      weave: item.weave,
      budgetMaxPaise: (25000 + (idx % 6) * 7500) * 100,
      size: ['S', 'M', 'L', 'XL'][idx % 4],
      colour: item.colour,
    },
    tags: ['demo', 'mock', 'regular_shopper'],
    status: 'ACTIVE',
    branchId: idx % 2 === 0 ? 'branch_main' : 'branch_two',
    language: ['en', 'hi', 'te', 'ta'][idx % 4],
    isLive: false,
    orders: idx % 3 === 0 ? [
      {
        orderId: `ord_gen_${String(idx + 1).padStart(2, '0')}`,
        status: 'COMPLETED',
        paid: true,
        netPaise: (18000 + (idx % 5) * 4500) * 100,
        completedAt: new Date(currentEngineTime.getTime() - (idx + 1) * 3 * 86400000),
        branchId: idx % 2 === 0 ? 'branch_main' : 'branch_two',
        lines: [
          {
            lineId: `line_gen_${idx + 1}`,
            itemRef: `item_${item.weave.toLowerCase().replace(/\s+/g, '_')}`,
            name: `${item.weave} Handcrafted Apparel`,
            quantity: 1,
            pricePaise: (18000 + (idx % 5) * 4500) * 100,
          },
        ],
      },
    ] : [],
  }));

  // Handle specific named scenario modifications
  if (scenario === 'birthday-today') {
    // Force first customer's birthday to today
    coreShopACustomers[0].birthday = { month: todayMonth, day: todayDay };
  } else if (scenario === 'household-collision') {
    // 1. Two mock customers sharing phone (+91 91000 00088) with occasions today
    const h1 = coreShopACustomers.find((c) => c.customerId === 'cus_household_1');
    const h2 = coreShopACustomers.find((c) => c.customerId === 'cus_household_2');
    if (h1) {
      h1.birthday = { month: todayMonth, day: todayDay };
      h1.events = [
        {
          eventId: 'evt_h1_anniv',
          type: 'anniversary',
          month: todayMonth,
          day: todayDay,
          label: 'Aarav Anniversary',
        },
      ];
    }
    if (h2) {
      h2.birthday = { month: todayMonth, day: todayDay };
      h2.events = [
        {
          eventId: 'evt_h2_anniv',
          type: 'anniversary',
          month: todayMonth,
          day: todayDay,
          label: 'Siddharth Anniversary',
        },
      ];
    }

    // 2. Live customers: if verified live recipient phone is configured,
    // configure customer with both birthday & anniversary today, plus a partner record sharing the same phone
    if (liveCustomers.length > 0) {
      const primaryLive = liveCustomers[0];
      primaryLive.birthday = { month: todayMonth, day: todayDay };
      primaryLive.events = [
        {
          eventId: `${primaryLive.customerId}_evt_anniv_today`,
          type: 'anniversary',
          month: todayMonth,
          day: todayDay,
          label: 'Wedding Anniversary',
        },
      ];

      // Create a second CRM customer sharing the same live destination phone
      const partnerLive: CustomerSeedRecord = {
        customerId: `${primaryLive.customerId}_partner`,
        firstName: `${primaryLive.firstName} (Partner)`,
        rawPhone: primaryLive.rawPhone,
        birthday: { month: todayMonth, day: todayDay },
        marketingOptIn: true,
        channelSuppressed: false,
        preferences: {
          weave: 'Banarasi Brocade',
          budgetMaxPaise: 4000000,
          size: 'M',
          colour: 'Crimson Red',
        },
        tags: ['live_test', 'verified', 'shared_phone', 'household'],
        status: 'ACTIVE',
        branchId: 'branch_main',
        language: 'en',
        isLive: true,
        events: [
          {
            eventId: `evt_partner_anniv_today`,
            type: 'anniversary',
            month: todayMonth,
            day: todayDay,
            label: 'Partner Anniversary',
          },
        ],
      };
      liveCustomers.push(partnerLive);
    }
  }

  // 3.5. Welcome Campaign Fixtures (scenario: welcome) - Mapping Edge Cases
  const welcomeShopACustomers: CustomerSeedRecord[] = [
    // 1. Mapping Test: Empty firstName
    {
      customerId: 'cus_map_01_empty',
      firstName: '',
      rawPhone: '+91 91000 00031',
      birthday: { month: 7, day: 10 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Chanderi' },
      tags: ['welcome', 'mapping-test'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
    },
    // 2. Mapping Test: Leading/trailing whitespace and newline
    {
      customerId: 'cus_map_02_whitespace',
      firstName: ' Lakshmi Devi \n',
      rawPhone: '+91 91000 00032',
      birthday: { month: 8, day: 15 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Kanjeevaram' },
      tags: ['welcome', 'mapping-test'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
    },
    // 3. Mapping Test: 300 character long name
    {
      customerId: 'cus_map_03_long',
      firstName: 'A'.repeat(300),
      rawPhone: '+91 91000 00033',
      birthday: { month: 9, day: 20 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Tussar' },
      tags: ['welcome', 'mapping-test'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
    },
    // 4. Mapping Test: Emoji in name
    {
      customerId: 'cus_map_04_emoji',
      firstName: 'Priya 🌸',
      rawPhone: '+91 91000 00034',
      birthday: { month: 10, day: 5 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Banarasi' },
      tags: ['welcome', 'mapping-test'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
    },
    // 5. Mapping Test: Tab character in name
    {
      customerId: 'cus_map_05_tab',
      firstName: 'Sunita\tDevi',
      rawPhone: '+91 91000 00035',
      birthday: { month: 11, day: 12 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Ikat' },
      tags: ['welcome', 'mapping-test'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
    },
  ];

  // 3.6. First to Second Purchase (Bring-Back) Fixtures (scenario: first-repeat)
  const firstRepeatShopACustomers: CustomerSeedRecord[] = [
    // 1. First paid order 5 days ago (eligible, both steps future)
    {
      customerId: 'cus_rep_01_5d',
      firstName: 'Kabir Verma',
      rawPhone: '+91 91000 00101',
      birthday: { month: 4, day: 15 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Kanjeevaram', budgetMaxPaise: 4000000 },
      tags: ['repeat', '5d_ago', 'eligible'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_01',
          status: 'COMPLETED',
          paid: true,
          netPaise: 250000,
          completedAt: new Date(currentEngineTime.getTime() - 5 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l1', itemRef: 'item_1', name: 'Silk Saree', quantity: 1, pricePaise: 250000 }],
        },
      ],
    },
    // 2. First paid order 20 days ago (eligible, both steps future)
    {
      customerId: 'cus_rep_02_20d',
      firstName: 'Divya Nair',
      rawPhone: '+91 91000 00102',
      birthday: { month: 5, day: 20 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Banarasi', budgetMaxPaise: 5000000 },
      tags: ['repeat', '20d_ago'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_02',
          status: 'COMPLETED',
          paid: true,
          netPaise: 350000,
          completedAt: new Date(currentEngineTime.getTime() - 20 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l2', itemRef: 'item_2', name: 'Banarasi Dupatta', quantity: 1, pricePaise: 350000 }],
        },
      ],
    },
    // 3. First paid order 35 days ago (step 1 +30d elapsed, step 2 +45d future)
    {
      customerId: 'cus_rep_03_35d',
      firstName: 'Rohan Mehra',
      rawPhone: '+91 91000 00103',
      birthday: { month: 6, day: 25 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Chanderi', budgetMaxPaise: 3000000 },
      tags: ['repeat', '35d_ago'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_03',
          status: 'COMPLETED',
          paid: true,
          netPaise: 180000,
          completedAt: new Date(currentEngineTime.getTime() - 35 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l3', itemRef: 'item_3', name: 'Kurta', quantity: 1, pricePaise: 180000 }],
        },
      ],
    },
    // 4. One completed at 20:30 local (15:00 UTC) -> deferred next day
    {
      customerId: 'cus_rep_04_night',
      firstName: 'Ananya Roy',
      rawPhone: '+91 91000 00104',
      birthday: { month: 7, day: 10 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Tussar', budgetMaxPaise: 3500000 },
      tags: ['repeat', 'night_order'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_04',
          status: 'COMPLETED',
          paid: true,
          netPaise: 220000,
          completedAt: new Date(new Date(currentEngineTime.getTime() - 2 * 24 * 3600 * 1000).setUTCHours(15, 0, 0, 0)),
          lines: [{ lineId: 'l4', itemRef: 'item_4', name: 'Stole', quantity: 1, pricePaise: 220000 }],
        },
      ],
    },
    // 5. 2 paid orders -> never enrolled
    {
      customerId: 'cus_rep_05_two_orders',
      firstName: 'Siddharth Rao',
      rawPhone: '+91 91000 00105',
      birthday: { month: 8, day: 18 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Khadi', budgetMaxPaise: 2000000 },
      tags: ['repeat', 'two_orders'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_05a',
          status: 'COMPLETED',
          paid: true,
          netPaise: 150000,
          completedAt: new Date(currentEngineTime.getTime() - 15 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l5a', itemRef: 'item_5', name: 'Shirt', quantity: 1, pricePaise: 150000 }],
        },
        {
          orderId: 'ord_rep_05b',
          status: 'COMPLETED',
          paid: true,
          netPaise: 200000,
          completedAt: new Date(currentEngineTime.getTime() - 5 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l5b', itemRef: 'item_6', name: 'Jacket', quantity: 1, pricePaise: 200000 }],
        },
      ],
    },
    // 6. Pending-only -> never enrolled
    {
      customerId: 'cus_rep_06_pending',
      firstName: 'Kavita Das',
      rawPhone: '+91 91000 00106',
      birthday: { month: 9, day: 5 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Cotton', budgetMaxPaise: 1500000 },
      tags: ['repeat', 'pending_only'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_06',
          status: 'PENDING',
          paid: false,
          netPaise: 120000,
          completedAt: null,
          lines: [{ lineId: 'l6', itemRef: 'item_7', name: 'Scarf', quantity: 1, pricePaise: 120000 }],
        },
      ],
    },
    // 7. Cancelled-only -> never enrolled
    {
      customerId: 'cus_rep_07_cancelled',
      firstName: 'Vikram Seth',
      rawPhone: '+91 91000 00107',
      birthday: { month: 10, day: 12 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Linen', budgetMaxPaise: 2500000 },
      tags: ['repeat', 'cancelled_only'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_07',
          status: 'CANCELLED',
          paid: false,
          netPaise: 200000,
          completedAt: null,
          lines: [{ lineId: 'l7', itemRef: 'item_8', name: 'Trouser', quantity: 1, pricePaise: 200000 }],
        },
      ],
    },
    // 8. Unpaid -> never enrolled
    {
      customerId: 'cus_rep_08_unpaid',
      firstName: 'Pooja Hegde',
      rawPhone: '+91 91000 00108',
      birthday: { month: 11, day: 22 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Mulberry Silk', budgetMaxPaise: 4500000 },
      tags: ['repeat', 'unpaid'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_08',
          status: 'COMPLETED',
          paid: false,
          netPaise: 300000,
          completedAt: new Date(currentEngineTime.getTime() - 10 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l8', itemRef: 'item_9', name: 'Shawl', quantity: 1, pricePaise: 300000 }],
        },
      ],
    },
    // 9. Net 0 -> never enrolled
    {
      customerId: 'cus_rep_09_net0',
      firstName: 'Manish Malhotra',
      rawPhone: '+91 91000 00109',
      birthday: { month: 12, day: 30 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Georgette', budgetMaxPaise: 6000000 },
      tags: ['repeat', 'net0'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_09',
          status: 'COMPLETED',
          paid: true,
          netPaise: 0,
          completedAt: new Date(currentEngineTime.getTime() - 7 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l9', itemRef: 'item_10', name: 'Free Sample', quantity: 1, pricePaise: 0 }],
        },
      ],
    },
    // 10. First fully refunded
    {
      customerId: 'cus_rep_10_refunded',
      firstName: 'Neha Kakkar',
      rawPhone: '+91 91000 00110',
      birthday: { month: 1, day: 8 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Organza', budgetMaxPaise: 3500000 },
      tags: ['repeat', 'fully_refunded'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_10',
          status: 'REFUNDED',
          paid: true,
          netPaise: 0,
          completedAt: new Date(currentEngineTime.getTime() - 12 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l10', itemRef: 'item_11', name: 'Dress', quantity: 1, pricePaise: 250000 }],
        },
      ],
    },
    // 11. First partially refunded (net > 0 remains qualifying)
    {
      customerId: 'cus_rep_11_partially_refunded',
      firstName: 'Tarun Tahiliani',
      rawPhone: '+91 91000 00111',
      birthday: { month: 2, day: 14 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Brocade', budgetMaxPaise: 8000000 },
      tags: ['repeat', 'partially_refunded'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_11',
          status: 'COMPLETED',
          paid: true,
          netPaise: 150000,
          completedAt: new Date(currentEngineTime.getTime() - 10 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l11', itemRef: 'item_12', name: 'Brocade Fabric', quantity: 1, pricePaise: 300000 }],
        },
      ],
    },
    // 12. A, B then A refunded -> saw 2 orders, so maxQualifyingOrderCountSeen >= 2
    {
      customerId: 'cus_rep_12_ab_refunded',
      firstName: 'Sabyasachi Mukherjee',
      rawPhone: '+91 91000 00112',
      birthday: { month: 3, day: 28 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Matka Silk', budgetMaxPaise: 10000000 },
      tags: ['repeat', 'ab_refunded'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_12a',
          status: 'REFUNDED',
          paid: true,
          netPaise: 0,
          grossPaise: 500000,
          refundedPaise: 500000,
          completedAt: new Date(currentEngineTime.getTime() - 25 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l12a', itemRef: 'item_13', name: 'Bridal Saree', quantity: 1, pricePaise: 500000 }],
        },
        {
          orderId: 'ord_rep_12b',
          status: 'COMPLETED',
          paid: true,
          netPaise: 250000,
          completedAt: new Date(currentEngineTime.getTime() - 15 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l12b', itemRef: 'item_14', name: 'Clutch', quantity: 1, pricePaise: 250000 }],
        },
      ],
    },
    // 13. Opted-out
    {
      customerId: 'cus_rep_13_opted_out',
      firstName: 'Anita Dongre',
      rawPhone: '+91 91000 00113',
      birthday: { month: 4, day: 19 },
      marketingOptIn: false,
      channelSuppressed: false,
      preferences: { weave: 'Bandhani', budgetMaxPaise: 4000000 },
      tags: ['repeat', 'opted_out'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_13',
          status: 'COMPLETED',
          paid: true,
          netPaise: 200000,
          completedAt: new Date(currentEngineTime.getTime() - 5 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l13', itemRef: 'item_15', name: 'Bandhani Saree', quantity: 1, pricePaise: 200000 }],
        },
      ],
    },
    // 14. Channel suppressed
    {
      customerId: 'cus_rep_14_suppressed',
      firstName: 'Ritu Kumar',
      rawPhone: '+91 91000 00114',
      birthday: { month: 5, day: 11 },
      marketingOptIn: true,
      channelSuppressed: true,
      preferences: { weave: 'Zari', budgetMaxPaise: 5000000 },
      tags: ['repeat', 'suppressed'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_14',
          status: 'COMPLETED',
          paid: true,
          netPaise: 220000,
          completedAt: new Date(currentEngineTime.getTime() - 5 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l14', itemRef: 'item_16', name: 'Zari Dupatta', quantity: 1, pricePaise: 220000 }],
        },
      ],
    },
    // 15. Deleted
    {
      customerId: 'cus_rep_15_deleted',
      firstName: 'Masaba Gupta',
      rawPhone: '+91 91000 00115',
      birthday: { month: 6, day: 14 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Crepe', budgetMaxPaise: 3000000 },
      tags: ['repeat', 'deleted'],
      status: 'DELETED',
      deletedAt: new Date(currentEngineTime.getTime() - 1 * 24 * 3600 * 1000),
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_15',
          status: 'COMPLETED',
          paid: true,
          netPaise: 180000,
          completedAt: new Date(currentEngineTime.getTime() - 5 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l15', itemRef: 'item_17', name: 'Tunic', quantity: 1, pricePaise: 180000 }],
        },
      ],
    },
    // 16. No phone / consent
    {
      customerId: 'cus_rep_16_no_phone',
      firstName: 'Gaurav Gupta',
      rawPhone: '',
      birthday: { month: 7, day: 22 },
      marketingOptIn: false,
      channelSuppressed: false,
      preferences: { weave: 'Sculptural Silk', budgetMaxPaise: 7000000 },
      tags: ['repeat', 'no_phone'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_16',
          status: 'COMPLETED',
          paid: true,
          netPaise: 350000,
          completedAt: new Date(currentEngineTime.getTime() - 5 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l16', itemRef: 'item_18', name: 'Gown', quantity: 1, pricePaise: 350000 }],
        },
      ],
    },
    // 17. Shared phone destination
    {
      customerId: 'cus_rep_17a_shared',
      firstName: 'Sunil Sethi',
      rawPhone: '+91 91000 00117',
      birthday: { month: 8, day: 9 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Cotton Silk', budgetMaxPaise: 2500000 },
      tags: ['repeat', 'shared_phone_a'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_17a',
          status: 'COMPLETED',
          paid: true,
          netPaise: 200000,
          completedAt: new Date(currentEngineTime.getTime() - 5 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l17a', itemRef: 'item_19', name: 'Kurta Set', quantity: 1, pricePaise: 200000 }],
        },
      ],
    },
    {
      customerId: 'cus_rep_17b_shared',
      firstName: 'Archana Kochhar',
      rawPhone: '+91 91000 00117',
      birthday: { month: 9, day: 19 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Cotton Silk', budgetMaxPaise: 2500000 },
      tags: ['repeat', 'shared_phone_b'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_rep_17b',
          status: 'COMPLETED',
          paid: true,
          netPaise: 200000,
          completedAt: new Date(currentEngineTime.getTime() - 4 * 24 * 3600 * 1000),
          lines: [{ lineId: 'l17b', itemRef: 'item_20', name: 'Anarkali', quantity: 1, pricePaise: 200000 }],
        },
      ],
    },
    // 18. Live customer with exactly one paid order completed 29 days ago and opted in
    ...liveCustomers.map((lc, idx) => ({
      ...lc,
      customerId: `cus_rep_live_${idx + 1}`,
      tags: [...(lc.tags || []), 'repeat', 'live_repeat'],
      events: (lc.events || []).map((e, eIdx) => ({
        ...e,
        eventId: `evt_rep_live_${idx + 1}_${eIdx + 1}`,
      })),
      orders: [
        {
          orderId: `ord_rep_live_${idx + 1}`,
          status: 'COMPLETED',
          paid: true,
          netPaise: 290000,
          completedAt: new Date(currentEngineTime.getTime() - 29 * 24 * 3600 * 1000),
          lines: [{ lineId: 'llive', itemRef: 'item_live', name: 'Designer Saree', quantity: 1, pricePaise: 290000 }],
        },
      ],
    })),
  ];

  // 3.7. Gift / Wedding Reminder Fixtures (scenario: gift-wedding)
  const kolkataNow = DateTime.fromJSDate(currentEngineTime, { zone: 'Asia/Kolkata' });
  const datePlus45 = kolkataNow.plus({ days: 45 });
  const datePlus10 = kolkataNow.plus({ days: 10 });
  const datePlus15 = kolkataNow.plus({ days: 15 });
  const datePlus40 = kolkataNow.plus({ days: 40 });
  const datePlus12 = kolkataNow.plus({ days: 12 });
  const dateMinus5 = kolkataNow.minus({ days: 5 });

  const toOccasionDate = (dt: DateTime) => ({
    eventDate: { year: dt.year, month: dt.month, day: dt.day },
    eventDateKey: dt.toISODate()!,
    month: dt.month,
    day: dt.day,
  });

  const giftWeddingShopACustomers: CustomerSeedRecord[] = [
    // 1. Customer with live wedding 45 days out (eligible, wedding campaign)
    {
      customerId: 'cus_gw_wedding_live',
      firstName: 'Kavita Sharma',
      rawPhone: '+91 91000 00201',
      birthday: { month: 8, day: 24 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Banarasi', budgetMaxPaise: 10000000 },
      tags: ['wedding', 'eligible', '45d_out'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      events: [
        {
          eventId: 'evt_gw_wed_1',
          type: 'wedding',
          kind: OCCASION_KIND.WEDDING,
          ...toOccasionDate(datePlus45),
          label: 'Kavita & Rohan Wedding',
          budgetPaise: 10000000,
          categories: ['BRIDAL_WEAR', 'SAREES'],
          status: OCCASION_STATUS.ACTIVE,
          declaredByCustomer: true,
          source: 'CUSTOMER_DECLARED',
        },
      ],
    },
    // 2. Customer with gift occasion 10 days out (recipientLabel: Mom, gift campaign)
    {
      customerId: 'cus_gw_gift_mom',
      firstName: 'Aarav Gupta',
      rawPhone: '+91 91000 00202',
      birthday: { month: 3, day: 12 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Chanderi', budgetMaxPaise: 2000000 },
      tags: ['gift', 'eligible', '10d_out'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      events: [
        {
          eventId: 'evt_gw_gift_1',
          type: 'gift',
          kind: OCCASION_KIND.GIFT,
          ...toOccasionDate(datePlus10),
          recipientLabel: 'Mom',
          label: 'Gift for Mom',
          budgetPaise: 1500000,
          categories: ['SAREES'],
          status: OCCASION_STATUS.ACTIVE,
          declaredByCustomer: true,
          source: 'CUSTOMER_DECLARED',
        },
      ],
    },
    // 3. Edge case: Wedding 15 days out (< 21 days lead time, tests lead time skip)
    {
      customerId: 'cus_gw_wed_short_lead',
      firstName: 'Pooja Iyer',
      rawPhone: '+91 91000 00203',
      birthday: { month: 6, day: 5 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Kanjeevaram', budgetMaxPaise: 8000000 },
      tags: ['wedding', 'short_lead', '15d_out'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      events: [
        {
          eventId: 'evt_gw_wed_short',
          type: 'wedding',
          kind: OCCASION_KIND.WEDDING,
          ...toOccasionDate(datePlus15),
          label: 'Pooja Wedding',
          budgetPaise: 8000000,
          categories: ['BRIDAL_WEAR'],
          status: OCCASION_STATUS.ACTIVE,
          declaredByCustomer: true,
          source: 'CUSTOMER_DECLARED',
        },
      ],
    },
    // 4. Edge case: Undeclared occasion (declaredByCustomer: false, tests exclusion)
    {
      customerId: 'cus_gw_undeclared',
      firstName: 'Sunita Patel',
      rawPhone: '+91 91000 00204',
      birthday: { month: 11, day: 19 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Tussar', budgetMaxPaise: 5000000 },
      tags: ['wedding', 'undeclared'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      events: [
        {
          eventId: 'evt_gw_wed_undeclared',
          type: 'wedding',
          kind: OCCASION_KIND.WEDDING,
          ...toOccasionDate(datePlus40),
          label: 'Staff Noted Wedding',
          budgetPaise: 5000000,
          categories: ['BRIDAL_WEAR'],
          status: OCCASION_STATUS.ACTIVE,
          declaredByCustomer: false,
          source: 'STAFF_ON_BEHALF',
        },
      ],
    },
    // 5. Edge case: Cancelled occasion (status: 'CANCELLED')
    {
      customerId: 'cus_gw_cancelled',
      firstName: 'Ramesh Reddy',
      rawPhone: '+91 91000 00205',
      birthday: { month: 2, day: 8 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Khadi', budgetMaxPaise: 1500000 },
      tags: ['gift', 'cancelled'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      events: [
        {
          eventId: 'evt_gw_gift_cancelled',
          type: 'gift',
          kind: OCCASION_KIND.GIFT,
          ...toOccasionDate(datePlus12),
          label: 'Cancelled Gift',
          budgetPaise: 1500000,
          categories: ['SAREES'],
          status: OCCASION_STATUS.CANCELLED,
          declaredByCustomer: true,
          source: 'CUSTOMER_DECLARED',
        },
      ],
    },
    // 6. Edge case: Occasion in the past (< today)
    {
      customerId: 'cus_gw_past',
      firstName: 'Meera Sen',
      rawPhone: '+91 91000 00206',
      birthday: { month: 7, day: 30 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Chanderi', budgetMaxPaise: 3000000 },
      tags: ['wedding', 'past'],
      status: 'ACTIVE',
      branchId: 'branch_main',
      language: 'en',
      isLive: false,
      events: [
        {
          eventId: 'evt_gw_wed_past',
          type: 'wedding',
          kind: OCCASION_KIND.WEDDING,
          ...toOccasionDate(dateMinus5),
          label: 'Past Wedding',
          budgetPaise: 3000000,
          categories: ['BRIDAL_WEAR'],
          status: OCCASION_STATUS.ACTIVE,
          declaredByCustomer: true,
          source: 'CUSTOMER_DECLARED',
        },
      ],
    },
  ];

  if (scenario === 'gift-wedding' && options.live && liveCustomers.length > 0) {
    const liveCust = liveCustomers[0];
    if (!liveCust.events) {
      liveCust.events = [];
    }
    liveCust.events.push({
      eventId: `${liveCust.customerId}_evt_wedding_live`,
      type: 'wedding',
      kind: OCCASION_KIND.WEDDING,
      ...toOccasionDate(datePlus45),
      label: 'Live Test Wedding',
      budgetPaise: 10000000,
      categories: ['BRIDAL_WEAR', 'SAREES'],
      status: OCCASION_STATUS.ACTIVE,
      declaredByCustomer: true,
      source: 'CUSTOMER_DECLARED',
    });
    liveCust.events.push({
      eventId: `${liveCust.customerId}_evt_gift_live`,
      type: 'gift',
      kind: OCCASION_KIND.GIFT,
      ...toOccasionDate(datePlus10),
      recipientLabel: 'Wife',
      label: 'Special Gift',
      budgetPaise: 2500000,
      categories: ['SAREES'],
      status: OCCASION_STATUS.ACTIVE,
      declaredByCustomer: true,
      source: 'CUSTOMER_DECLARED',
    });
  }

  const isBase = scenario === 'base';
  const shopACustomers = isBase
    ? [
        ...liveCustomers,
        ...coreShopACustomers,
        ...generatedShopACustomers,
      ]
    : [
        ...(options.live ? liveCustomers : []),
        ...(scenario === 'welcome' ? welcomeShopACustomers : []),
        ...(scenario === 'first-repeat' ? firstRepeatShopACustomers : []),
        ...(scenario === 'gift-wedding' ? giftWeddingShopACustomers : []),
      ];

  // 4. Shop B Customers (Tenant isolation verification fixtures)
  const shopBCustomers: CustomerSeedRecord[] = isBase
    ? [
    {
      customerId: 'cus_b_001',
      firstName: 'Boutique B Customer 1',
      rawPhone: '+91 92000 00001',
      birthday: { month: todayMonth, day: todayDay },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Chanderi', budgetMaxPaise: 2000000, size: 'M', colour: 'Pastel Lilac' },
      tags: ['demo', 'shop_b', 'mock'],
      status: 'ACTIVE',
      branchId: 'branch_b_main',
      language: 'en',
      isLive: false,
      orders: [
        {
          orderId: 'ord_b_001',
          status: 'COMPLETED',
          paid: true,
          netPaise: 340000,
          completedAt: new Date('2026-10-05T12:00:00Z'),
          branchId: 'branch_b_main',
          lines: [
            {
              lineId: 'line_b_001',
              itemRef: 'item_shop_b_saree',
              name: 'Shop B Chanderi Saree',
              quantity: 1,
              pricePaise: 340000,
            },
          ],
        },
      ],
    },
    {
      customerId: 'cus_b_002',
      firstName: 'Boutique B Customer 2',
      rawPhone: '+91 92000 00002',
      birthday: { month: 11, day: 28 },
      marketingOptIn: false,
      channelSuppressed: false,
      preferences: { weave: 'Tussar', budgetMaxPaise: 3000000, size: 'L', colour: 'Sand' },
      tags: ['demo', 'shop_b', 'mock'],
      status: 'ACTIVE',
      branchId: 'branch_b_main',
      language: 'en',
      isLive: false,
    },
    {
      customerId: 'cus_b_003',
      firstName: 'Boutique B Customer 3',
      rawPhone: '+91 92000 00003',
      birthday: { month: 4, day: 14 },
      marketingOptIn: true,
      channelSuppressed: true,
      preferences: { weave: 'Banarasi', budgetMaxPaise: 5500000, size: 'S', colour: 'Scarlet' },
      tags: ['demo', 'shop_b', 'mock'],
      status: 'ACTIVE',
      branchId: 'branch_b_main',
      language: 'hi',
      isLive: false,
    },
    {
      customerId: 'cus_b_004',
      firstName: 'Boutique B Customer 4 (Deleted)',
      rawPhone: '+91 92000 00004',
      birthday: { month: 8, day: 19 },
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Linen', budgetMaxPaise: 1500000, size: 'M', colour: 'Navy' },
      tags: ['demo', 'shop_b', 'deleted'],
      status: 'DELETED',
      branchId: 'branch_b_main',
      deletedAt: new Date('2026-07-01T00:00:00Z'),
      language: 'en',
      isLive: false,
    },
    {
      customerId: 'cus_b_005',
      firstName: 'Boutique B Customer 5',
      rawPhone: '+91 92000 00005',
      birthday: null,
      marketingOptIn: true,
      channelSuppressed: false,
      preferences: { weave: 'Ikat', budgetMaxPaise: 2800000, size: 'XL', colour: 'Forest Green' },
      tags: ['demo', 'shop_b', 'mock'],
      status: 'ACTIVE',
      branchId: 'branch_b_main',
      language: 'en',
      isLive: false,
      events: [
        {
          eventId: 'evt_b_anniv_01',
          type: 'anniversary',
          month: 12,
          day: 10,
          label: 'Anniversary Shop B',
        },
      ],
    },
  ]
  : [];

  return { shopACustomers, shopBCustomers };
}
