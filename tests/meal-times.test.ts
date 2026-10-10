import test from 'node:test';
import assert from 'node:assert/strict';
import { reservationSlots, validSlotTime } from '../src/lib/meal-times';
const now = Date.parse('2026-10-10T09:45:00+08:00');
const options = [{ date: '2026-10-10', reservationOptionText: '早餐(06:14至10:15)，午餐(10:44至14:15)，下午茶(14:44至16:45)，夜市(17:14至21:45)' }];
test('provider breakfast and regular windows are parsed without inventing default times', () => {
  const slots=reservationSlots(options,now);
  assert.equal(slots.length,4);assert.equal(slots[0].period,'breakfast');assert.equal(slots[1].period,'regular');
  assert.equal(slots[1].start,'10:44');assert.equal(slots[1].end,'14:15');
  assert(validSlotTime(slots[1],'12:30',now));
  for(const time of ['10:20','14:16','25:00',''])assert(!validSlotTime(slots[1],time,now));
  assert(!validSlotTime(slots[0],'09:30',now));
});
test('passed windows disappear while tomorrow remains available', () => {
  const slots=reservationSlots([...options,{date:'2026-10-11',reservationOptionText:'早餐(06:14至10:15)'}],Date.parse('2026-10-10T15:00:00+08:00'));
  assert.equal(slots.filter(s=>s.period==='breakfast').length,1);
  assert.equal(slots.find(s=>s.period==='breakfast')!.date,'2026-10-11');
  assert.equal(reservationSlots([{date:'2026-10-10',reservationOptionText:'特殊活动：请在官方应用确认'}],now).length,0);
});
