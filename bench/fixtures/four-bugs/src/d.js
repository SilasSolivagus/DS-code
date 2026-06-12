export function initials(name) {
  return name.split(' ').map(w => w[0].toUpperCase()).join('') // bug: 连续空格产生空词会崩
}
