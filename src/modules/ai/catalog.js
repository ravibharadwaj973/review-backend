/**
 * Built-in service catalogues by business type. Used when Groq is unavailable,
 * and as a reference list the AI can build on. Prices are typical INR starting points.
 * Each row: [category, name, price, durationMinutes]
 */
const C = {
  salon: [
    ['Hair', 'Haircut (women)', 600, 45], ['Hair', 'Haircut (men)', 300, 30], ['Hair', 'Kids haircut', 250, 20],
    ['Hair', 'Blow-dry', 400, 30], ['Hair', 'Hair wash & conditioning', 300, 20], ['Hair', 'Hair spa', 1200, 60],
    ['Hair', 'Global hair colour', 2500, 120], ['Hair', 'Root touch-up', 1200, 60], ['Hair', 'Highlights', 3500, 150],
    ['Hair', 'Keratin treatment', 4500, 150], ['Hair', 'Hair smoothening', 5000, 180], ['Hair', 'Anti-dandruff treatment', 1000, 45],
    ['Skin', 'Cleanup', 700, 30], ['Skin', 'Classic facial', 1000, 45], ['Skin', 'Gold facial', 1800, 60],
    ['Skin', 'Hydra facial', 3000, 60], ['Skin', 'De-tan pack', 600, 30], ['Skin', 'Bleach', 400, 20],
    ['Waxing & threading', 'Eyebrow threading', 60, 10], ['Waxing & threading', 'Upper lip threading', 40, 5],
    ['Waxing & threading', 'Full arms waxing', 400, 20], ['Waxing & threading', 'Full legs waxing', 600, 30],
    ['Waxing & threading', 'Full body waxing', 2000, 90],
    ['Hands & feet', 'Manicure', 600, 40], ['Hands & feet', 'Pedicure', 800, 50], ['Hands & feet', 'Spa pedicure', 1200, 60],
    ['Nails', 'Gel nail polish', 800, 45], ['Nails', 'Nail extensions', 1800, 90], ['Nails', 'Nail art', 500, 30],
    ['Makeup', 'Party makeup', 3000, 75], ['Makeup', 'Bridal makeup', 15000, 180], ['Makeup', 'Saree draping', 500, 20],
  ],
  barber: [
    ['Hair', 'Haircut', 250, 30], ['Hair', 'Kids haircut', 200, 20], ['Hair', 'Hair wash', 100, 10], ['Hair', 'Hair colour', 700, 45],
    ['Beard', 'Beard trim', 150, 15], ['Beard', 'Beard styling', 250, 20], ['Beard', 'Clean shave', 150, 15],
    ['Grooming', 'Head massage', 300, 20], ['Grooming', 'Face cleanup', 500, 30], ['Grooming', 'De-tan', 400, 20],
  ],
  spa: [
    ['Massage', 'Swedish massage (60 min)', 2500, 60], ['Massage', 'Deep tissue massage', 3000, 60], ['Massage', 'Aromatherapy massage', 2800, 60],
    ['Massage', 'Balinese massage', 3000, 60], ['Massage', 'Thai massage', 2800, 60], ['Massage', 'Foot reflexology', 1200, 30],
    ['Massage', 'Head & shoulder massage', 900, 30], ['Body', 'Body scrub', 2000, 45], ['Body', 'Body wrap', 2500, 60],
    ['Therapies', 'Couple massage', 5500, 60], ['Therapies', 'Steam bath', 600, 20], ['Therapies', 'Hot stone therapy', 3500, 75],
  ],
  gym: [
    ['Membership', 'Monthly membership', 2500, 0], ['Membership', 'Quarterly membership', 6500, 0], ['Membership', 'Annual membership', 20000, 0],
    ['Training', 'Personal training session', 800, 60], ['Training', 'Personal training (monthly)', 9000, 0], ['Training', 'Diet & nutrition plan', 2000, 30],
    ['Classes', 'Zumba class', 400, 45], ['Classes', 'Yoga class', 400, 60], ['Classes', 'HIIT class', 400, 45], ['Classes', 'CrossFit class', 500, 60],
    ['Classes', 'Spinning class', 400, 45], ['Assessment', 'Body composition analysis', 500, 20],
  ],
  yoga: [
    ['Classes', 'Hatha yoga class', 400, 60], ['Classes', 'Power yoga class', 500, 60], ['Classes', 'Prenatal yoga', 600, 60],
    ['Classes', 'Meditation session', 300, 45], ['Classes', 'Pranayama session', 300, 45], ['Private', 'Private yoga session', 1500, 60],
    ['Membership', 'Monthly unlimited classes', 3500, 0], ['Courses', 'Teacher training course', 40000, 0],
  ],
  dental: [
    ['Consultation', 'Dental check-up', 500, 20], ['Cleaning', 'Scaling & polishing', 1500, 45], ['Cleaning', 'Teeth whitening', 8000, 60],
    ['Treatment', 'Tooth filling', 1500, 45], ['Treatment', 'Root canal treatment', 6000, 90], ['Treatment', 'Tooth extraction', 1500, 30],
    ['Treatment', 'Wisdom tooth removal', 5000, 60], ['Restorative', 'Dental crown', 7000, 60], ['Restorative', 'Dental implant', 30000, 120],
    ['Orthodontics', 'Braces', 40000, 0], ['Orthodontics', 'Clear aligners', 90000, 0], ['Kids', 'Kids dental check-up', 400, 20],
  ],
  clinic: [
    ['Consultation', 'General consultation', 600, 20], ['Consultation', 'Follow-up visit', 300, 15], ['Consultation', 'Online consultation', 500, 15],
    ['Tests', 'Blood test', 800, 15], ['Tests', 'ECG', 500, 15], ['Tests', 'Full body check-up', 3500, 120],
    ['Procedures', 'Vaccination', 800, 15], ['Procedures', 'Dressing', 300, 15], ['Procedures', 'Minor procedure', 2500, 45],
    ['Care', 'Home visit', 1500, 45], ['Care', 'Health certificate', 500, 15],
  ],
  physio: [
    ['Therapy', 'Physiotherapy session', 900, 45], ['Therapy', 'Back pain therapy', 1000, 45], ['Therapy', 'Neck pain therapy', 1000, 45],
    ['Therapy', 'Knee rehab', 1000, 45], ['Therapy', 'Sports injury rehab', 1200, 60], ['Therapy', 'Post-surgery rehab', 1200, 60],
    ['Treatments', 'Dry needling', 1200, 30], ['Treatments', 'Cupping therapy', 800, 30], ['Treatments', 'Kinesio taping', 500, 20],
    ['Assessment', 'Posture assessment', 800, 30], ['Care', 'Home physiotherapy', 1500, 60],
  ],
  restaurant: [
    ['Dining', 'Dine-in', 0, 0], ['Dining', 'Takeaway', 0, 0], ['Dining', 'Home delivery', 0, 0],
    ['Meals', 'Lunch thali', 250, 0], ['Meals', 'Buffet', 600, 0], ['Meals', 'Breakfast', 200, 0],
    ['Events', 'Birthday party', 0, 180], ['Events', 'Private dining', 0, 120], ['Events', 'Catering', 0, 0], ['Events', 'Corporate lunch', 0, 0],
  ],
  cafe: [
    ['Drinks', 'Coffee', 180, 0], ['Drinks', 'Cold coffee', 220, 0], ['Drinks', 'Tea', 120, 0], ['Drinks', 'Smoothies & shakes', 250, 0],
    ['Food', 'Breakfast', 300, 0], ['Food', 'Sandwiches', 250, 0], ['Food', 'Pasta', 350, 0], ['Food', 'Desserts & cakes', 200, 0],
    ['Services', 'Takeaway', 0, 0], ['Services', 'Home delivery', 0, 0], ['Services', 'Workspace / Wi-Fi seating', 0, 0], ['Events', 'Small events', 0, 120],
  ],
  hotel: [
    ['Rooms', 'Standard room', 2500, 0], ['Rooms', 'Deluxe room', 3500, 0], ['Rooms', 'Suite', 6000, 0],
    ['Dining', 'Restaurant', 0, 0], ['Dining', 'Room service', 0, 0], ['Dining', 'Breakfast buffet', 500, 0],
    ['Events', 'Banquet hall', 0, 0], ['Events', 'Wedding venue', 0, 0], ['Events', 'Conference room', 0, 0],
    ['Services', 'Airport pickup', 1200, 0], ['Services', 'Laundry', 0, 0], ['Leisure', 'Swimming pool', 0, 0],
  ],
  auto: [
    ['Service', 'General car service', 3500, 240], ['Service', 'Oil change', 1500, 45], ['Service', 'Wheel alignment', 600, 30],
    ['Service', 'Wheel balancing', 400, 30], ['Repair', 'Brake repair', 2000, 90], ['Repair', 'AC repair', 2500, 120], ['Repair', 'Denting & painting', 5000, 0],
    ['Care', 'Car wash', 400, 30], ['Care', 'Interior cleaning', 1200, 90], ['Care', 'Ceramic coating', 15000, 0], ['Care', 'Bike service', 800, 120],
  ],
  education: [
    ['Classes', 'Group tuition', 2000, 60], ['Classes', 'One-to-one tuition', 5000, 60], ['Courses', 'Competitive exam coaching', 30000, 0],
    ['Courses', 'Spoken English course', 5000, 0], ['Courses', 'Computer course', 6000, 0], ['Classes', 'Demo class', 0, 45],
    ['Support', 'Doubt-clearing session', 500, 45], ['Support', 'Mock tests', 1000, 0],
  ],
  pet: [
    ['Grooming', 'Bath & blow-dry', 800, 60], ['Grooming', 'Full grooming', 1500, 90], ['Grooming', 'Nail clipping', 200, 15],
    ['Vet', 'Vet consultation', 600, 20], ['Vet', 'Vaccination', 900, 15], ['Care', 'Pet boarding (per night)', 800, 0], ['Care', 'Dog training', 3000, 60],
  ],
  general: [
    ['Services', 'Consultation', 0, 30], ['Services', 'Standard service', 0, 60], ['Services', 'Premium service', 0, 90],
    ['Services', 'Home visit', 0, 60], ['Services', 'Follow-up', 0, 30], ['Products', 'Product sales', 0, 0],
  ],
};

export function catalogKey(category = '') {
  const c = category.toLowerCase();
  if (/barber/.test(c)) return 'barber';
  if (/spa|massage/.test(c)) return 'spa';
  if (/salon|beauty|parlou?r|hair|nail|makeup/.test(c)) return 'salon';
  if (/yoga|pilates|meditation/.test(c)) return 'yoga';
  if (/gym|fitness|crossfit|zumba/.test(c)) return 'gym';
  if (/dent/.test(c)) return 'dental';
  if (/physio|rehab|chiro/.test(c)) return 'physio';
  if (/clinic|hospital|doctor|medical|diagnos/.test(c)) return 'clinic';
  if (/cafe|café|coffee|bakery/.test(c)) return 'cafe';
  if (/restaurant|dhaba|food|kitchen|bar|pub|bistro/.test(c)) return 'restaurant';
  if (/hotel|resort|homestay|guest/.test(c)) return 'hotel';
  if (/car|auto|garage|bike|motor/.test(c)) return 'auto';
  if (/school|tuition|coaching|academy|institute|class/.test(c)) return 'education';
  if (/pet|vet|dog/.test(c)) return 'pet';
  return 'general';
}

export function catalogFor(category) {
  return (C[catalogKey(category)] || C.general).map(([cat, name, price, duration]) => ({
    category: cat,
    name,
    price: price || null,
    duration: duration || null,
    description: '',
  }));
}
