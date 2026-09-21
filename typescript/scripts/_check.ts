import { accrueInterest, levelPayment, amortisationSchedule, AmortisationMethod, AccrualBasis } from "../src/interest.js";
console.log("accrue 10000@5% x1 =", accrueInterest(10000, 500, 1));
console.log("accrue 10000@5% x2 =", accrueInterest(10000, 500, 2));
console.log("simple             =", accrueInterest(10000, 500, 2, AccrualBasis.Simple));
console.log("levelPayment       =", levelPayment(120000, 100, 12));
for (const m of [AmortisationMethod.EqualInstalment, AmortisationMethod.EqualPrincipal, AmortisationMethod.InterestOnly]) {
  const s = amortisationSchedule(100000, 250, 6, m);
  console.log(" ", m.padEnd(17), s.instalments.map((r) => r.payment).join(","), " sum", s.totalPaid, " interest", s.totalInterest);
}
let bad = 0, n = 0;
for (const p of [0, 1, 7, 100, 9999, 1000000, 987654321]) {
  for (const rate of [0, 1, 37, 250, 1000, 5000]) {
    for (const periods of [1, 2, 3, 12, 60, 360]) {
      for (const m of [AmortisationMethod.EqualInstalment, AmortisationMethod.EqualPrincipal, AmortisationMethod.InterestOnly]) {
        n += 1;
        const s = amortisationSchedule(p, rate, periods, m);
        if (s.instalments[s.instalments.length - 1]!.closingBalance !== 0) bad += 1;
        if (s.totalPaid !== p + s.totalInterest) bad += 1;
      }
    }
  }
}
console.log(`\n${n} schedules swept, ${bad} that did not close or add up`);
