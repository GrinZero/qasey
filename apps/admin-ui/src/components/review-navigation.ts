const eventName = "qasey:review-navigation";

export function allowReviewNavigation(): boolean {
  return window.dispatchEvent(new Event(eventName, { cancelable: true }))
    || window.confirm("还有未保存的用例修改。确定离开并放弃修改吗？");
}

export function protectReviewNavigation(): () => void {
  const prevent = (event: Event) => event.preventDefault();
  window.addEventListener(eventName, prevent);
  return () => window.removeEventListener(eventName, prevent);
}
