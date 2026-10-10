// Coupon eligibility comes only from exact product codes in the current store's response.
// Never stack unrelated coupons, bind coupons, or assume that an advertised amount is payable.
export function couponQuoteVariants(baseArgs, coupons, maximum = 4) {
  const variants = [{ args: structuredClone(baseArgs), coupon: null, itemIndex: null }];
  const seen = new Set();
  for (let itemIndex = 0; itemIndex < baseArgs.items.length; itemIndex++) {
    const item = baseArgs.items[itemIndex];
    for (const coupon of coupons) {
      if (typeof coupon.couponId !== 'string' || typeof coupon.couponCode !== 'string' || !coupon.products?.some(p => p.productCode === item.productCode)) continue;
      const key = `${itemIndex}|${coupon.couponId}`; if (seen.has(key)) continue; seen.add(key);
      const args = structuredClone(baseArgs);
      args.items[itemIndex] = { ...args.items[itemIndex], couponId: coupon.couponId, couponCode: coupon.couponCode };
      variants.push({ args, coupon: { title: coupon.title, couponId: coupon.couponId, couponCode: coupon.couponCode }, itemIndex });
      if (variants.length >= maximum) return variants;
    }
  }
  return variants;
}
