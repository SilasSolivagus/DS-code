export function initials(name) {
  return name.split(' ').map(w => w[0].toUpperCase()).join('')
}
