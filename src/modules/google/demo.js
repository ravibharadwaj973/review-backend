/**
 * Demo sandbox: lets a business explore the full workflow before Google grants
 * API access. Everything created here is labelled "demo" and never sent to Google.
 */

const NAMES = [
  'Priya Sharma', 'Rahul Verma', 'Ananya Gupta', 'Amit Kumar', 'Sneha Reddy', 'Vikram Singh', 'Neha Kapoor',
  'Arjun Mehta', 'Kavya Nair', 'Rohan Joshi', 'Isha Malhotra', 'Karan Bhatia', 'Pooja Iyer', 'Aditya Rao',
  'Meera Pillai', 'Siddharth Jain', 'Tanvi Desai', 'Nikhil Chopra', 'Riya Sen', 'Harsh Agarwal', 'Divya Menon',
  'Manish Tiwari', 'Shruti Bansal', 'Varun Khanna', 'Aisha Khan', 'Gaurav Saxena', 'Nisha Arora', 'Kunal Shah',
];

// {s} is replaced with a service name from the business
const TEMPLATES = [
  { r: 5, t: 'Really liked the {s} and the staff was very friendly. Will definitely come back!' },
  { r: 5, t: 'Best {s} I have had in a long time. Very professional team and the place is spotless.' },
  { r: 5, t: 'Booked a {s} on short notice and they still made time for me. Lovely experience overall.' },
  { r: 5, t: 'Very clean and hygienic. The {s} was relaxing and worth every rupee.' },
  { r: 5, t: "Amazing service. The team listened carefully to what I wanted. Highly recommend the {s}." },
  { r: 5, t: 'Friendly staff, calm ambience and great {s}. My go-to place now.' },
  { r: 5, t: '' },
  { r: 4, t: '{s} was great but I had to wait 30 minutes even with an appointment.' },
  { r: 4, t: 'Good {s}, polite staff. Slightly expensive compared to other places nearby.' },
  { r: 4, t: 'Nice experience overall. The {s} was good, parking is a bit of a problem though.' },
  { r: 4, t: 'Staff is skilled and helpful. Weekends are very crowded so book ahead.' },
  { r: 3, t: 'The {s} was okay. Nothing special for the price. Waiting area was crowded.' },
  { r: 3, t: 'Decent service but my appointment was delayed by 40 minutes and nobody informed me.' },
  { r: 2, t: 'Not happy with the {s}. It was rushed and the staff seemed busy with other customers.' },
  { r: 2, t: 'Overpriced for what you get. Waited a long time and the {s} was average.' },
  { r: 1, t: 'Very disappointed. Rude receptionist and they cancelled my booking without telling me.' },
];

const REPLIES = [
  'Thank you so much for your kind words! We are delighted you enjoyed your visit and look forward to seeing you again.',
  'Thanks for visiting us and sharing your feedback. We are glad you liked the service!',
];

let seq = 0;
const rand = (arr, i) => arr[i % arr.length];

export function demoReviews(serviceNames = [], { count = 42, monthsBack = 12 } = {}) {
  const services = serviceNames.length ? serviceNames : ['Haircut', 'Hair Spa', 'Facial', 'Manicure'];
  const now = Date.now();
  const out = [];
  // Deterministic but varied distribution; ~80% 4-5 stars
  const weights = [0, 1, 2, 3, 4, 5, 0, 1, 2, 4, 5, 3, 0, 7, 8, 1, 9, 10, 2, 4, 11, 5, 0, 13, 1, 3, 7, 12, 4, 2, 15, 5, 8, 0, 1, 14, 3, 4, 9, 6, 2, 5];
  for (let i = 0; i < count; i += 1) {
    const tpl = TEMPLATES[weights[i % weights.length]];
    const service = rand(services, i * 7 + 3);
    // newer reviews more frequent
    const ageDays = Math.floor(Math.pow(i / count, 1.4) * monthsBack * 30) + (i % 3);
    const createTime = new Date(now - ageDays * 864e5 - (i * 3671 % 86400) * 1000);
    const answered = ageDays > 6 && (tpl.r >= 4 ? i % 4 !== 0 : i % 2 === 0);
    out.push({
      googleReviewName: `demo/reviews/${i}`,
      googleReviewId: `demo-${i}`,
      reviewer: { name: rand(NAMES, i * 5 + 1), isAnonymous: false },
      rating: tpl.r,
      comment: tpl.t.replace('{s}', service.toLowerCase()),
      createTime,
      updateTime: createTime,
      reply: answered
        ? { comment: rand(REPLIES, i), updateTime: new Date(createTime.getTime() + ((i % 4) + 1) * 864e5 * 0.7) }
        : undefined,
    });
  }
  return out;
}

/** A single fresh review, used by "Simulate a new review" in demo mode. */
export function demoNewReview(serviceNames = [], { reviewerName } = {}) {
  seq += 1;
  const services = serviceNames.length ? serviceNames : ['Haircut'];
  const idx = Math.floor(Math.random() * TEMPLATES.length);
  const tpl = TEMPLATES[idx].t ? TEMPLATES[idx] : TEMPLATES[0];
  const service = services[Math.floor(Math.random() * services.length)];
  const now = new Date();
  return {
    googleReviewName: `demo/reviews/live-${now.getTime()}-${seq}`,
    googleReviewId: `demo-live-${now.getTime()}-${seq}`,
    reviewer: { name: reviewerName || NAMES[Math.floor(Math.random() * NAMES.length)], isAnonymous: false },
    rating: tpl.r,
    comment: tpl.t.replace('{s}', service.toLowerCase()),
    createTime: now,
    updateTime: now,
  };
}
