// 满减：超过 100 减 10
export function applyCoupon(total) {
  return total > 100 ? total - 10 : total
}

// 会员折扣 95 折
export function memberDiscount(total, isMember) {
  return isMember ? total * 0.95 : total
}

// 结算
export function checkout(total, isMember) {
  return applyCoupon(memberDiscount(total, isMember))
}
