document.getElementById('year').textContent = new Date().getFullYear();

// Mobile nav toggle
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');

navToggle.addEventListener('click', () => {
  const isOpen = navLinks.classList.toggle('is-open');
  navToggle.setAttribute('aria-expanded', String(isOpen));
});

navLinks.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('is-open');
    navToggle.setAttribute('aria-expanded', 'false');
  });
});

// Navbar shadow on scroll
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.style.boxShadow = window.scrollY > 8 ? '0 8px 24px -12px rgba(0,0,0,0.5)' : 'none';
});

// FAQ accordion
document.querySelectorAll('.accordion__item').forEach((item) => {
  const trigger = item.querySelector('.accordion__trigger');
  const panel = item.querySelector('.accordion__panel');

  trigger.addEventListener('click', () => {
    const isOpen = item.classList.contains('is-open');

    document.querySelectorAll('.accordion__item').forEach((other) => {
      other.classList.remove('is-open');
      other.querySelector('.accordion__panel').style.maxHeight = null;
    });

    if (!isOpen) {
      item.classList.add('is-open');
      panel.style.maxHeight = panel.scrollHeight + 'px';
    }
  });
});

// Copy contract address (disabled until a real address is live) - only
// present on index.html, so this whole block is skipped on other pages
// that share this file (staking.html, nft.html) rather than throwing.
const copyBtn = document.getElementById('copyBtn');
const contractAddress = document.getElementById('contractAddress');

if (copyBtn && contractAddress) {
  copyBtn.addEventListener('click', async () => {
    const text = contractAddress.textContent.trim();
    const isPlaceholder = text.toUpperCase().includes('TBA');

    if (isPlaceholder) {
      copyBtn.textContent = 'Not live yet';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = 'Copied!';
    } catch (err) {
      copyBtn.textContent = 'Copy failed';
    } finally {
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    }
  });
}
